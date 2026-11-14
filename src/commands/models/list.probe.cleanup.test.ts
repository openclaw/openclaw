import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAgentCleanupScope } from "../../agents/run-cleanup-timeout.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as embeddedStateLock from "../../infra/embedded-state-lock.js";
import { captureNativeSignalBridge } from "../../infra/embedded-state-lock.test-support.js";
import * as gatewayLockProcessModule from "../../infra/gateway-lock-process.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as agentDatabaseDisposal from "../../state/openclaw-agent-db-disposal.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runAuthProbes, withAuthProbeStateOwnership } from "./list.probe.js";

const runner = vi.hoisted(() =>
  vi.fn<(params: { agentDir: string; abortSignal?: AbortSignal }) => Promise<{ text: string }>>(),
);
// mock-isolation: Controlled completion tails exercise cleanup without starting inference.
vi.mock("../../agents/isolated-completion.js", () => ({ runIsolatedCompletion: runner }));

const createNativeBridge = embeddedStateLock.createEmbeddedStateSignalBridge;
const acquireNativeStateLock = embeddedStateLock.acquireEmbeddedStateLock;
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let signals: ReturnType<typeof captureNativeSignalBridge>;
const provider = { apiKey: "config-key", baseUrl: "https://probe.invalid", models: [] };
const lockPath = () => state.path("locks", "gateway.state.lock");
function expectOwnership(held: boolean) {
  expect(fs.existsSync(lockPath())).toBe(held);
  expect(signals.listenerCount("SIGTERM")).toBe(Number(held));
}
beforeEach(async () => {
  state = await createOpenClawTestState({
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  signals = captureNativeSignalBridge(createNativeBridge);
  vi.spyOn(embeddedStateLock, "createEmbeddedStateSignalBridge").mockImplementationOnce(
    signals.create,
  );
  vi.spyOn(gatewayLockProcessModule, "readGatewayLockProcessStartTime").mockReturnValue(123456);
  const options = {
    allowInTests: true,
    env: state.env,
    lockDir: state.path("locks"),
    timeoutMs: 100,
  };
  vi.spyOn(embeddedStateLock, "acquireEmbeddedStateLock").mockImplementation((params) =>
    acquireNativeStateLock({ ...params, options }),
  );
});
afterEach(async () => {
  signals.dispose();
  vi.restoreAllMocks();
  runner.mockReset();
  await state.cleanup();
});

async function probeParams(concurrency: number) {
  const cfg: OpenClawConfig = { models: { providers: { "probe-control": provider } } };
  await state.writeConfig(cfg);
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
    stateOwnership: { mode: "exclusive" as const },
  };
}

it("holds state ownership for an in-flight sibling after progress rejects the probe batch", async () => {
  const params = await probeParams(2);
  const profile = { type: "api_key", provider: "probe-control", key: "stored-key" };
  await state.writeAuthProfiles({ version: 1, profiles: { "probe-control:stored": profile } });
  const firstStarted = createDeferredCore<AbortSignal | undefined>();
  const finishFirst = createDeferredCore();
  runner.mockImplementation(async ({ abortSignal }) => {
    firstStarted.resolve(abortSignal);
    await finishFirst.promise;
    return { text: "OK" };
  });
  const parent = new AsyncWorkScope();
  const original = new Error("synthetic progress failure");
  let starts = 0;
  let operation: Promise<unknown> | undefined;
  try {
    operation = parent.track(() =>
      runAuthProbes({
        ...params,
        onProgress(update) {
          if (update.label && ++starts === 2) {
            throw original;
          }
        },
      }),
    );
    await expect(operation).rejects.toBe(original);
    const firstSignal = await firstStarted.promise;
    expectOwnership(true);
    signals.emit("SIGTERM");
    expect(firstSignal?.aborted).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(true);
    finishFirst.resolve();
    await parent.drain();
    expectOwnership(false);
  } finally {
    finishFirst.resolve();
    await operation?.catch(() => {});
    await parent.drain();
  }
});

it("retains the staged directory and releases state ownership when database disposal reports failure", async () => {
  const params = await probeParams(1);
  const original = new Error("synthetic database disposal failure");
  let stagedDir: string | undefined;
  runner.mockImplementation(async ({ agentDir }) => {
    stagedDir = agentDir;
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
    await expect(cleanup.run(() => runAuthProbes(params))).rejects.toMatchObject({
      cause: original,
    });
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
  await expect(
    inParent(() => withAuthProbeStateOwnership({ mode: "exclusive" }, run)),
  ).rejects.toThrow("Async work scope is closed");
  expect(run).not.toHaveBeenCalled();
  expectOwnership(false);
});
