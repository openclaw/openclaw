import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAgentCleanupScope } from "../../agents/run-cleanup-timeout.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { validateConfigObject } from "../../config/validation.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as agentDatabaseDisposal from "../../state/openclaw-agent-db-disposal.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { runAuthProbes, withAuthProbeStateOwnership } from "./list.probe.js";

const runner = vi.hoisted(() =>
  vi.fn<(params: { agentDir: string; abortSignal?: AbortSignal }) => Promise<{ text: string }>>(),
);
// mock-isolation: Controlled completion tails exercise cleanup without starting inference.
vi.mock("../../agents/isolated-completion.js", () => ({ runIsolatedCompletion: runner }));

let state: OpenClawTestState;
let signals: EventEmitter;
let cfg: OpenClawConfig;
const lockPath = () => state.path("locks", "gateway.state.lock");
function expectOwnership(held: boolean) {
  expect(fs.existsSync(lockPath())).toBe(held);
  expect(signals.listenerCount("SIGTERM")).toBe(held ? 1 : 0);
}
beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "probe-cleanup",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  signals = new EventEmitter();
});
async function prepareProbe() {
  cfg = createProbeConfig(state.workspaceDir);
  expect(validateConfigObject(cfg)).toMatchObject({ ok: true });
  await state.writeConfig(cfg);
}
afterEach(async () => {
  vi.restoreAllMocks();
  runner.mockReset();
  await state.cleanup();
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

function stateOwnership() {
  return {
    mode: "exclusive" as const,
    process: signals,
    gatewayLockOptions: {
      allowInTests: true,
      env: state.env,
      lockDir: state.path("locks"),
      readProcessStartTime: () => 123456,
      timeoutMs: 100,
    },
  };
}

function probeParams(concurrency: number) {
  return {
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
      concurrency,
      maxTokens: 8,
    },
    stateOwnership: stateOwnership(),
  };
}

it("holds state ownership for an in-flight sibling after progress rejects the probe batch", async () => {
  await prepareProbe();
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
    return { text: "OK" };
  });
  const parent = new AsyncWorkScope();
  const original = new Error("synthetic progress failure");
  let starts = 0;
  let operation: Promise<unknown> | undefined;
  try {
    operation = parent.track(() =>
      runAuthProbes({
        ...probeParams(2),
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
    expectOwnership(true);
    signals.emit("SIGTERM");
    expect(firstSignal?.aborted).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(true);
    finishFirst.resolve();
    await firstFinished.promise;
    await parent.drain();
    expectOwnership(false);
  } finally {
    finishFirst.resolve();
    await operation?.catch(() => {});
    if (firstRan) {
      await firstFinished.promise;
    }
    await parent.drain();
  }
});

it("retains the staged directory and releases state ownership when database disposal reports failure", async () => {
  await prepareProbe();
  const original = new Error("synthetic database disposal failure");
  let stagedDir: string | undefined;
  runner.mockImplementation(async (params) => {
    stagedDir = params.agentDir;
    return { text: "OK" };
  });
  const dispose = agentDatabaseDisposal.disposeOpenClawAgentDatabaseByPath;
  const close = vi
    .spyOn(agentDatabaseDisposal, "disposeOpenClawAgentDatabaseByPath")
    .mockImplementation(async (pathname, options) => {
      const closed = await dispose(pathname, options);
      if (stagedDir && pathname.startsWith(stagedDir + path.sep)) {
        throw original;
      }
      return closed;
    });
  const cleanup = createAgentCleanupScope();
  try {
    await expect(cleanup.run(() => runAuthProbes(probeParams(1)))).rejects.toMatchObject({
      cause: original,
    });
    expect(stagedDir).toContain("openclaw-auth-probe-");
    expect(fs.existsSync(stagedDir!)).toBe(true);
    expect(
      agentDatabase
        .listOpenClawRegisteredAgentDatabases({ env: state.env })
        .some((entry) => entry.path.startsWith(stagedDir! + path.sep)),
    ).toBe(false);
    expectOwnership(false);
    expect(cleanup.outcome).toBe("uncertain");
  } finally {
    close.mockRestore();
    if (stagedDir) {
      await dispose(path.join(stagedDir, "openclaw-agent.sqlite"), { env: state.env });
      await fs.promises.rm(stagedDir, { recursive: true, force: true });
    }
  }
});

it("does not acquire probe state from a closed caller scope", async () => {
  const parent = new AsyncWorkScope();
  const inParent = parent.run(() => AsyncLocalStorage.snapshot());
  await parent.drain();
  const run = vi.fn(async () => undefined);
  await expect(inParent(() => withAuthProbeStateOwnership(stateOwnership(), run))).rejects.toThrow(
    "Async work scope is closed",
  );
  expect(run).not.toHaveBeenCalled();
  expectOwnership(false);
});
