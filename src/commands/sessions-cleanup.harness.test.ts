import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import * as sessions from "../config/sessions.js";
import {
  appendTranscriptMessageSync,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as gatewayLock from "../infra/gateway-lock.js";
import { createPluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import * as nativeModule from "../plugins/native-module-require.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createNonExitingRuntime } from "../runtime.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { cleanupSummary } from "./sessions-cleanup-summary.test-support.js";
import { sessionsCleanupCommand } from "./sessions-cleanup.js";
import { runLocalSessionsCleanup } from "./sessions-cleanup.runtime.js";

const OWNER_PLUGIN_ID = "cleanup-owner";
const HARNESS_ID = "cleanup-runtime";
const STORE_OPTIONS = {
  namespace: "session-bindings",
  maxEntries: 10,
  overflowPolicy: "reject-new",
} as const;
const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));

function cleanupFixture(
  state: OpenClawTestState,
  sessionKey: string,
  plugins: OpenClawConfig["plugins"] = { enabled: false },
  withModel = false,
) {
  const cfg: OpenClawConfig = {
    agents: {
      ...(withModel ? { defaults: { model: { primary: "other-provider/other-model" } } } : {}),
      entries: { main: { workspace: state.workspaceDir } },
    },
    plugins,
    session: {
      maintenance: { mode: "warn", pruneAfter: "1d", preserveRecent: false, maxDiskBytes: false },
    },
  };
  setRuntimeConfigSnapshot(cfg, cfg);
  const scope = {
    agentId: "main",
    sessionKey,
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  const runtime = createNonExitingRuntime();
  const output = vi.spyOn(runtime, "writeJson").mockImplementation(() => {});
  return {
    scope,
    output,
    runtime,
    read: () => loadSessionEntry({ ...scope, readConsistency: "latest" }),
    cleanup: (options: Parameters<typeof sessionsCleanupCommand>[0] = { json: true }) =>
      sessionsCleanupCommand({ store: scope.storePath, enforce: true, ...options }, runtime),
  };
}

function writeCleanupPlugins(bundledRoot: string) {
  const owner = writePlugin({
    id: OWNER_PLUGIN_ID,
    dir: path.join(bundledRoot, OWNER_PLUGIN_ID),
    filename: "index.cjs",
    body: `require("node:fs").writeFileSync(require("node:path").join(__dirname, "loaded"), "loaded");
      module.exports = {
      id: ${JSON.stringify(OWNER_PLUGIN_ID)},
      register(api) {
        api.registerAgentHarness({
          id: ${JSON.stringify(HARNESS_ID)},
          label: "Cleanup owner",
          supports: () => ({ supported: false }),
          async runAttempt() { throw new Error("cleanup must not run an agent turn"); },
          async withSessionDeletion(params, run) {
            params.assertCurrent();
            const bindings = api.runtime.state.openSyncKeyedStore(${JSON.stringify(STORE_OPTIONS)});
            const key = JSON.stringify([params.agentId, params.sessionKey, params.sessionId]);
            const previous = bindings.lookup(key);
            return await run({
              commit() {
                params.assertCurrent();
                bindings.delete(key);
              },
              rollback() {
                params.assertCurrent();
                if (previous !== undefined) bindings.register(key, previous);
              },
            });
          },
        });
      },
    };`,
  });
  writeJson(path.join(owner.dir, "openclaw.plugin.json"), {
    id: owner.id,
    activation: { onStartup: false, onAgentHarnesses: [HARNESS_ID] },
    configSchema: { type: "object", additionalProperties: false },
  });
  writeJson(path.join(owner.dir, "package.json"), {
    name: `@openclaw/${owner.id}`,
    openclaw: { extensions: ["./index.cjs"] },
  });
  const unrelated = writePlugin({
    id: "unrelated-cleanup-plugin",
    body: `require("node:fs").writeFileSync(require("node:path").join(__dirname, "loaded"), "loaded");
      module.exports = { id: "unrelated-cleanup-plugin", register() {} };`,
  });
  return { owner, unrelated };
}

beforeEach(() => {
  // Retain lazy initialization while using the harness's real mocked runtime graph.
  const nativeLoad = nativeModule.tryNativeRequireModule;
  const runtimePaths = new Set([
    path.resolve("src/plugins/runtime/index.ts"),
    path.resolve("dist/plugins/runtime/index.js"),
  ]);
  vi.spyOn(nativeModule, "tryNativeRequireModule").mockImplementation((modulePath, options) =>
    runtimePaths.has(modulePath)
      ? { ok: true, moduleExport: { createPluginRuntime } }
      : nativeLoad(modulePath, options),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetPluginLoaderTestStateForTest();
});

afterAll(cleanupPluginLoaderFixturesForTest);

it("keeps prior store summaries when a later target returns a failure", async () => {
  await withOpenClawTestState(
    {
      label: "cleanup-partial",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_BUNDLED_PLUGINS_DIR: undefined },
    },
    async (state) => {
      const target = (agentId: string) => ({
        agentId,
        storePath: state.statePath(`agents/${agentId}/sessions/sessions.json`),
      });
      const mainSummary = cleanupSummary({
        mode: "enforce",
        dryRun: false,
      });
      vi.spyOn(sessions, "runSessionsCleanup")
        .mockResolvedValueOnce({
          mode: "enforce",
          previewResults: [],
          appliedSummaries: [mainSummary],
        })
        .mockRejectedValueOnce(new Error("injected later-store failure"));
      const result = await runLocalSessionsCleanup(
        {
          cfg: { plugins: { enabled: false } },
          opts: { enforce: true },
          targets: [target("main"), target("work")],
        },
        createNonExitingRuntime(),
      );
      expect(result.appliedSummaries).toEqual([mainSummary]);
      expect(result.failure).toMatchObject({ target: target("work"), lifecycleCommitted: false });
    },
  );
});

it("refuses an owned store, permits preview, and cleans only after exclusive admission", async () => {
  await withOpenClawTestState({ label: "cleanup-maintenance-owner" }, async (state) => {
    const { scope, read, cleanup, output } = cleanupFixture(state, "agent:main:hook:owned-cleanup");
    const entry = { sessionId: "owned-cleanup", updatedAt: Date.now() - 40 * 86_400_000 };
    await replaceSessionEntry(scope, entry);
    const acquire = gatewayLock.acquireGatewayLock;
    vi.spyOn(gatewayLock, "acquireGatewayLock").mockImplementation((opts) =>
      acquire({ ...opts, timeoutMs: 0 }),
    );
    const owner = await acquire({ allowInTests: true, port: 18789, timeoutMs: 0 });
    if (!owner) {
      throw new Error("expected Gateway owner");
    }
    try {
      await expect(cleanup({})).rejects.toThrow(
        `OpenClaw process (PID ${process.pid}) owns this state; run Gateway-delegated cleanup without --store, or stop the Gateway`,
      );
      expect(read()).toMatchObject(entry);
      await cleanup({ dryRun: true, json: true });
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true, wouldMutate: true }),
        2,
      );
      expect(read()).toMatchObject(entry);
    } finally {
      await owner.release();
    }
    await cleanup();
    expect(read()).toBeUndefined();
  });
});

it.each([
  { label: "recorded", metadata: "recorded", activation: "enabled" },
  { label: "legacy", metadata: "legacy", activation: "enabled" },
  { label: "implicitly permitted", metadata: "recorded", activation: "implicit" },
  { label: "explicitly disabled", metadata: "recorded", activation: "disabled" },
  { label: "explicitly disabled legacy", metadata: "legacy", activation: "disabled" },
  { label: "globally disabled", metadata: "recorded", activation: "globally-disabled" },
  { label: "denylisted", metadata: "recorded", activation: "denylisted" },
  { label: "outside the allowlist", metadata: "recorded", activation: "not-allowlisted" },
] as const)(
  "reclaims allowed $label ownership and reports policy exclusions without running unrelated plugins",
  async ({ metadata, activation }) => {
    await withOpenClawTestState({ label: "offline-harness-cleanup" }, async (state) => {
      const bundledRoot = state.path("bundled-plugins");
      const { owner, unrelated } = writeCleanupPlugins(bundledRoot);
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledRoot);
      const sessionKey = "agent:main:hook:cleanup-owned";
      const siblingKey = "agent:main:cleanup-kept";
      const { scope, read, cleanup, runtime } = cleanupFixture(
        state,
        sessionKey,
        {
          enabled: activation !== "globally-disabled",
          allow: activation === "not-allowlisted" ? [unrelated.id] : [owner.id, unrelated.id],
          ...(activation === "denylisted" ? { deny: [owner.id] } : {}),
          entries: {
            ...(activation === "implicit"
              ? {}
              : { [owner.id]: { enabled: activation !== "disabled" } }),
            [unrelated.id]: { enabled: true },
          },
          load: { paths: [unrelated.file] },
          slots: { memory: "none" },
        },
        true,
      );
      const sessionId = "shared-physical-id";
      const entry = {
        sessionId,
        updatedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
        ...(metadata === "recorded" ? { agentHarnessId: HARNESS_ID } : {}),
      };
      await replaceSessionEntry(scope, entry);
      appendTranscriptMessageSync(
        { ...scope, sessionId },
        { message: { role: "user", content: "Stored cleanup fixture" } },
      );
      await replaceSessionEntry(scope, entry);
      await replaceSessionEntry(
        { ...scope, sessionKey: siblingKey },
        { ...entry, updatedAt: Date.now() },
      );
      const bindings = createPluginStateSyncKeyedStore<{ threadId: string }>(
        owner.id,
        STORE_OPTIONS,
      );
      const key = JSON.stringify(["main", sessionKey, sessionId]);
      const siblingBindingKey = JSON.stringify(["main", siblingKey, sessionId]);
      bindings.register(key, { threadId: "removed-thread" });
      bindings.register(siblingBindingKey, { threadId: "kept-thread" });
      const warnings = vi.spyOn(runtime, "error").mockImplementation(() => {});
      const activeRegistry = getActivePluginRegistry();
      expect(read()).toMatchObject(entry);

      await cleanup();

      expect(read()).toBeUndefined();
      if (activation !== "enabled" && activation !== "implicit") {
        expect(bindings.lookup(key)).toEqual({ threadId: "removed-thread" });
        expect(fs.existsSync(path.join(owner.dir, "loaded"))).toBe(false);
        expect(warnings.mock.calls.flat().join("\n")).toContain(owner.id);
        expect(warnings.mock.calls.flat().join("\n")).toContain("not cleaned");
      } else {
        expect(bindings.lookup(key)).toBeUndefined();
        expect(warnings).not.toHaveBeenCalled();
      }
      expect(loadSessionEntry({ ...scope, sessionKey: siblingKey })?.sessionId).toBe(sessionId);
      expect(bindings.lookup(siblingBindingKey)).toEqual({ threadId: "kept-thread" });
      expect(fs.existsSync(path.join(unrelated.dir, "loaded"))).toBe(false);
      expect(getActivePluginRegistry()).toBe(activeRegistry);
    });
  },
);
