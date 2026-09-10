import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentCleanupScope } from "../../agents/run-cleanup-timeout.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { validateConfigObject } from "../../config/validation.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runAuthProbes, withAuthProbeStateOwnership } from "./list.probe.js";

const runner = vi.hoisted(() =>
  vi.fn<
    (params: {
      agentDir: string;
      abortSignal?: AbortSignal;
    }) => Promise<{ payloads: Array<{ text: string }> }>
  >(),
);
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: runner }));

afterEach(() => {
  vi.restoreAllMocks();
  runner.mockReset();
});

function createProbeConfig(workspaceDir: string): OpenClawConfig {
  return {
    agents: {
      entries: { main: { workspace: workspaceDir } },
      defaults: { workspace: workspaceDir },
    },
    models: {
      providers: {
        "probe-control": {
          api: "openai-completions",
          apiKey: "synthetic-config-credential",
          baseUrl: "https://fixture.invalid/v1",
          models: [
            {
              id: "probe-model",
              name: "Probe model",
              contextWindow: 8192,
              maxTokens: 64,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
  };
}

it("holds state ownership for an in-flight sibling after progress rejects the probe batch", async () => {
  const state = await createOpenClawTestState({
    label: "probe-sibling-cleanup",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  const cfg = createProbeConfig(state.workspaceDir);
  expect(validateConfigObject(cfg)).toMatchObject({ ok: true });
  await state.writeConfig(cfg);
  await state.writeAuthProfiles({
    version: 1,
    profiles: {
      "probe-control:stored": {
        type: "api_key",
        provider: "probe-control",
        key: "synthetic-stored-credential",
      },
    },
  });
  const signals = new EventEmitter();
  const lockDir = state.path("locks");
  const lockPath = path.join(lockDir, "gateway.state.lock");
  const firstStarted = createDeferredCore();
  const finishFirst = createDeferredCore();
  const firstFinished = createDeferredCore();
  let firstSignal: AbortSignal | undefined;
  let firstRan = false;
  runner.mockImplementation(async (params) => {
    firstRan = true;
    firstSignal = params.abortSignal;
    firstStarted.resolve();
    await finishFirst.promise;
    firstFinished.resolve();
    return { payloads: [{ text: "OK" }] };
  });
  const parent = new AsyncWorkScope();
  const original = new Error("synthetic progress failure");
  let starts = 0;
  let operation: Promise<unknown> | undefined;
  try {
    operation = parent.track(() =>
      runAuthProbes({
        cfg,
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        providers: ["probe-control"],
        modelCandidates: ["probe-control/probe-model"],
        options: {
          provider: "probe-control",
          includeDirectKeys: true,
          timeoutMs: 10_000,
          concurrency: 2,
          maxTokens: 8,
        },
        stateOwnership: {
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
        onProgress(update) {
          expect(update.total).toBe(2);
          if (update.label && ++starts === 2) {
            throw original;
          }
        },
      }),
    );
    await expect(operation).rejects.toBe(original);
    await firstStarted.promise;
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    signals.emit("SIGTERM");
    expect(firstSignal?.aborted).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    finishFirst.resolve();
    await firstFinished.promise;
    await parent.drain();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  } finally {
    finishFirst.resolve();
    await operation?.catch(() => {});
    if (firstRan) {
      await firstFinished.promise;
    }
    await parent.drain();
    await state.cleanup();
  }
});

it("removes the staged directory and releases state ownership when database disposal reports failure", async () => {
  const state = await createOpenClawTestState({
    label: "probe-disposal-failure",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  const cfg = createProbeConfig(state.workspaceDir);
  expect(validateConfigObject(cfg)).toMatchObject({ ok: true });
  await state.writeConfig(cfg);
  const signals = new EventEmitter();
  const lockDir = state.path("locks");
  const original = new Error("synthetic database disposal failure");
  let stagedDir: string | undefined;
  runner.mockImplementation(async (params) => {
    stagedDir = params.agentDir;
    return { payloads: [{ text: "OK" }] };
  });
  const dispose = agentDatabase.disposeOpenClawAgentDatabaseByPath;
  const close = vi
    .spyOn(agentDatabase, "disposeOpenClawAgentDatabaseByPath")
    .mockImplementation((pathname, options) => {
      const closed = dispose(pathname, options);
      if (stagedDir && pathname.startsWith(stagedDir + path.sep)) {
        throw original;
      }
      return closed;
    });
  const cleanup = createAgentCleanupScope();
  try {
    await expect(
      cleanup.run(() =>
        runAuthProbes({
          cfg,
          agentId: "main",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          providers: ["probe-control"],
          modelCandidates: ["probe-control/probe-model"],
          options: {
            provider: "probe-control",
            includeDirectKeys: true,
            timeoutMs: 10_000,
            concurrency: 1,
            maxTokens: 8,
          },
          stateOwnership: {
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
        }),
      ),
    ).rejects.toBe(original);
    expect(stagedDir).toContain("openclaw-auth-probe-");
    expect(fs.existsSync(stagedDir!)).toBe(false);
    expect(fs.existsSync(path.join(lockDir, "gateway.state.lock"))).toBe(false);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(cleanup.outcome).toBe("uncertain");
  } finally {
    close.mockRestore();
    await state.cleanup();
  }
});

it("does not acquire probe state from a closed caller scope", async () => {
  const state = await createOpenClawTestState({ label: "probe-closed-caller" });
  const parent = new AsyncWorkScope();
  const inParent = parent.run(() => AsyncLocalStorage.snapshot());
  await parent.drain();
  const signals = new EventEmitter();
  const lockDir = state.path("locks");
  const run = vi.fn(async () => undefined);
  try {
    await expect(
      inParent(() =>
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
      ),
    ).rejects.toThrow("Async work scope is closed");
    expect(run).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(lockDir, "gateway.state.lock"))).toBe(false);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  } finally {
    await state.cleanup();
  }
});
