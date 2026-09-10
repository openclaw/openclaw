import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import { loadPersistedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import { resolveAuthProfileDatabasePath } from "../../agents/auth-profiles/sqlite.js";
import { makeAttemptResult } from "../../agents/embedded-agent-runner/run.overflow-compaction.fixture.js";
import type { EmbeddedRunAttemptParams } from "../../agents/embedded-agent-runner/run/types.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import { createAgentCleanupScope } from "../../agents/run-cleanup-timeout.js";
import { loadExactSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { validateConfigObject } from "../../config/validation.js";
import { setLoggerOverride } from "../../logging/logger.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { PluginRegistryInspectionResources } from "../../plugins/registry-inspection-resources.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import {
  AsyncWorkScope,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runAuthProbes, withAuthProbeStateOwnership } from "./list.probe.js";

const attempt = vi.hoisted(() => vi.fn<(params: EmbeddedRunAttemptParams) => unknown>());
vi.mock("../../agents/embedded-agent-runner/run/attempt.js", () => ({
  runEmbeddedAttempt: attempt,
}));

it.each([
  "late-success",
  "exclusive",
  "sigterm",
  "late-failure",
  "db-close-failure",
  "discovery",
] as const)("keeps probe-owned state through bounded engine cleanup (%s)", async (mode) => {
  const state = await createOpenClawTestState({
    label: "probe-cleanup-resources",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS: "25" },
  });
  const pluginId = "probe-resource-fixture";
  const provider = "probe-resource-provider";
  const pluginRoot = state.path("plugin");
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.mkdirSync(state.agentDir(), { recursive: true });
  const entry = path.join(pluginRoot, "index.cjs");
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify({
      name: pluginId,
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({ id: pluginId, providers: [provider], configSchema: { type: "object" } }),
  );
  fs.writeFileSync(
    entry,
    `module.exports = { id: '${pluginId}', register(api) { api.registerProvider({ id: '${provider}', label: 'Probe resource fixture', auth: [] }); } };`,
  );
  const cfg: OpenClawConfig = {
    agents: {
      entries: { main: { workspace: state.workspaceDir } },
      defaults: { workspace: state.workspaceDir, model: { primary: `${provider}/probe-model` } },
    },
    models: {
      providers: {
        [provider]: {
          api: "openai-completions",
          apiKey: "synthetic-probe-credential",
          baseUrl: "https://fixture.invalid/v1",
          models: [
            {
              id: "probe-model",
              name: "Probe model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 64,
            },
          ],
        },
      },
    },
    plugins: {
      allow: [pluginId],
      load: { paths: [pluginRoot] },
      slots: { memory: "none", contextEngine: pluginId },
      entries: { [pluginId]: { enabled: true } },
    },
  };
  expect(validateConfigObject(cfg)).toMatchObject({ ok: true });
  await state.writeConfig(cfg);
  const source = new PluginRegistryInspectionResources();
  const builder = createPluginRegistry({
    runtime: createPluginRuntime(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    activateGlobalSideEffects: false,
  });
  source.attach(builder.registry);
  const record = createPluginRecord({ id: pluginId, source: entry });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, {
    config: cfg,
    registrationMode: mode === "discovery" ? "discovery" : "full",
  });
  const disposalStarted = createDeferredCore();
  const finishDisposal = createDeferredCore();
  const childStarted = createDeferredCore();
  const finishChild = createDeferredCore();
  const childFinished = createDeferredCore();
  const signals = new EventEmitter();
  const lockDir = state.path("locks");
  const lockPath = path.join(lockDir, "gateway.state.lock");
  const exclusive = mode !== "late-success";
  let factoryCalls = 0;
  let probeTarget: EmbeddedRunAttemptParams["sessionTarget"];
  let attemptAgentDir: string | undefined;
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  let cleanupSignal: AbortSignal | undefined;
  let stagedAgentDir: string | undefined;
  let profileId: string | undefined;
  let assertAdmitted: (() => void) | undefined;
  const reads: boolean[] = [];
  const readProbeState = () => {
    if (!stagedAgentDir || !profileId) {
      throw new Error("Probe factory did not capture its owned state");
    }
    reads.push(fs.readFileSync(path.join(stagedAgentDir, "probe-marker"), "utf8") === "owned");
    reads.push(Boolean(loadPersistedAuthProfileStore(stagedAgentDir)?.profiles[profileId]));
  };
  source.runRegistration(pluginId, () => {
    api.registerContextEngine(pluginId, (ctx) => {
      factoryCalls++;
      stagedAgentDir = ctx.agentDir;
      if (!stagedAgentDir) {
        throw new Error("Probe factory needs its staged agent directory");
      }
      profileId = Object.keys(loadPersistedAuthProfileStore(stagedAgentDir)?.profiles ?? {}).find(
        (id) => id.includes(":probe-"),
      );
      fs.writeFileSync(path.join(stagedAgentDir, "probe-marker"), "owned");
      return {
        info: { id: pluginId, name: "Probe cleanup fixture" },
        ingest: async () => ({ ingested: false }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false }),
        async dispose() {
          cleanupSignal = getAsyncWorkSignal();
          disposalStarted.resolve();
          await finishDisposal.promise;
          readProbeState();
          if (mode === "late-failure") {
            throw new Error("synthetic engine disposal failure");
          }
          void trackAsyncWork(async () => {
            childStarted.resolve();
            await finishChild.promise;
            try {
              readProbeState();
            } finally {
              childFinished.resolve();
            }
          }).catch(() => {});
        },
      };
    });
  });
  setActivePluginRegistry(builder.registry);
  attempt.mockImplementation((params) => {
    expect(params.disableTools).toBe(true);
    expect(params.modelRun).toBe(true);
    attemptAgentDir = params.agentDir;
    probeTarget = params.sessionTarget;
    if (mode !== "discovery") {
      expect(params.agentDir).toBe(stagedAgentDir);
    }
    assertAdmitted = resolveAdmittedRunActiveAssertion(params.admittedRunContext);
    assertAdmitted?.();
    return makeAttemptResult({ sessionIdUsed: params.sessionId, assistantTexts: ["OK"] });
  });
  if (mode === "db-close-failure") {
    setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "compact" });
    const dispose = agentDatabase.disposeOpenClawAgentDatabaseByPath;
    vi.spyOn(agentDatabase, "disposeOpenClawAgentDatabaseByPath").mockImplementation(
      (pathname, options) => {
        const closed = dispose(pathname, options);
        if (stagedAgentDir && pathname.startsWith(stagedAgentDir + path.sep)) {
          throw new Error("synthetic late database disposal failure");
        }
        return closed;
      },
    );
  }
  const readProbeSession = () => {
    if (!probeTarget?.sessionKey || !probeTarget.storePath) {
      throw new Error("Probe did not provide its hidden session target");
    }
    return loadExactSessionEntry({
      storePath: probeTarget.storePath,
      sessionKey: probeTarget.sessionKey,
      agentId: probeTarget.agentId,
    });
  };
  const parent = new AsyncWorkScope();
  const cleanup = createAgentCleanupScope();
  let operation: ReturnType<typeof runAuthProbes> | undefined;
  let drain: Promise<void> | undefined;
  try {
    operation = parent.track(() =>
      cleanup.run(() =>
        runAuthProbes({
          cfg,
          agentId: "main",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          providers: [provider],
          modelCandidates: [`${provider}/probe-model`],
          ...(exclusive
            ? {
                stateOwnership: {
                  mode: "exclusive" as const,
                  process: signals,
                  gatewayLockOptions: {
                    allowInTests: true,
                    env: state.env,
                    lockDir,
                    readProcessStartTime: () => 123456,
                    timeoutMs: 100,
                  },
                },
              }
            : {}),
          options: {
            provider,
            includeDirectKeys: true,
            timeoutMs: 10_000,
            concurrency: 1,
            maxTokens: 8,
          },
        }),
      ),
    );
    if (mode === "discovery") {
      expect((await operation).results).toMatchObject([{ status: "ok" }]);
      await parent.drain();
      expect(factoryCalls).toBe(0);
      expect(attempt).toHaveBeenCalledOnce();
      expect(attemptAgentDir).toContain("openclaw-auth-probe-");
      expect(fs.existsSync(attemptAgentDir!)).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
      return;
    }
    await Promise.race([
      disposalStarted.promise,
      operation.then((result) => {
        throw new Error(
          `Probe returned without engine disposal: ${JSON.stringify(result.results.map((probe) => ({ status: probe.status, error: probe.error })))}`,
        );
      }),
    ]);
    const reported = await operation;
    expect(reported.results).toMatchObject([{ status: "ok" }]);
    expect(attempt).toHaveBeenCalledOnce();
    expect(stagedAgentDir).toContain("openclaw-auth-probe-");
    expect(stagedAgentDir).not.toBe(state.agentDir());
    expect(assertAdmitted).toBeTypeOf("function");
    expect(() => assertAdmitted?.()).toThrow();
    expect(fs.existsSync(stagedAgentDir!)).toBe(true);
    expect(readProbeSession()?.entry).toBeDefined();
    expect(
      agentDatabase.isOpenClawAgentDatabaseOpen(resolveAuthProfileDatabasePath(stagedAgentDir!)),
    ).toBe(true);
    if (exclusive) {
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(signals.listenerCount("SIGTERM")).toBe(1);
    }
    expect(cleanupSignal?.aborted).toBe(false);
    if (mode === "sigterm") {
      signals.emit("SIGTERM");
      expect(cleanupSignal?.aborted).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(true);
    }
    finishDisposal.resolve();
    if (mode !== "late-failure") {
      await childStarted.promise;
      expect(fs.existsSync(stagedAgentDir!)).toBe(true);
      finishChild.resolve();
      await childFinished.promise;
    }
    drain = parent.drain();
    await drain;
    expect(reads).toEqual(mode === "late-failure" ? [true, true] : [true, true, true, true]);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(fs.existsSync(stagedAgentDir!)).toBe(false);
    expect(readProbeSession()?.entry).toBeUndefined();
    if (mode === "db-close-failure") {
      expect(warnings).toHaveBeenCalledWith(
        expect.stringContaining("synthetic late database disposal failure"),
      );
    }
    expect(
      agentDatabase.isOpenClawAgentDatabaseOpen(resolveAuthProfileDatabasePath(stagedAgentDir!)),
    ).toBe(false);
    expect(fs.existsSync(state.agentDir())).toBe(true);
    expect(cleanup.outcome).toBe("uncertain");
  } finally {
    finishDisposal.resolve();
    finishChild.resolve();
    await operation;
    await drain;
    await parent.drain();
    await source.release();
    await resetPreparedModelRuntimeSnapshotsForTest();
    clearPluginMetadataLifecycleCaches();
    resetPluginRuntimeStateForTest();
    attempt.mockReset();
    vi.restoreAllMocks();
    setLoggerOverride(null);
    await state.cleanup();
  }
});

it.each([false, true])(
  "releases direct state ownership before propagating no-tail failure (async: %s)",
  async (asynchronous) => {
    const state = await createOpenClawTestState({ label: "probe-no-tail-failure" });
    const signals = new EventEmitter();
    const lockDir = state.path("locks");
    const original = new Error("synthetic direct probe failure");
    const run = asynchronous
      ? async () => {
          await Promise.resolve();
          throw original;
        }
      : () => {
          throw original;
        };
    try {
      await expect(
        withAuthProbeStateOwnership(
          {
            mode: "exclusive",
            process: signals,
            gatewayLockOptions: {
              allowInTests: true,
              env: state.env,
              lockDir,
              readProcessStartTime: () => 123456,
              timeoutMs: 100,
            },
          },
          run,
        ),
      ).rejects.toBe(original);
      expect(fs.existsSync(path.join(lockDir, "gateway.state.lock"))).toBe(false);
      expect(signals.listenerCount("SIGINT")).toBe(0);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    } finally {
      await state.cleanup();
    }
  },
);
