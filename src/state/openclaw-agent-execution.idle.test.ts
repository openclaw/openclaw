import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
} from "./openclaw-agent-db-lifecycle.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-contract.js";
import * as native from "./openclaw-agent-execution-native.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    resetGatewayWorkAdmission();
    clearRuntimeConfigSnapshot();
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  }),
);
const opened: { agentId: string; close: ReturnType<typeof vi.fn<() => Promise<void>>> }[] = [];
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  vi.useFakeTimers();
  env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-idle-")) };
  opened.length = 0;
  // Exercise the real borrow/release owner without booting native workers for timer tests.
  vi.spyOn(native, "createAgentDatabaseNativeGeneration").mockImplementation((agentId) => {
    const close = vi.fn(async () => {});
    opened.push({ agentId, close });
    return {
      close,
      run: async () => undefined,
      failure: () => undefined,
      isPrepared: () => false,
      captureClaim: () => {
        throw new Error("Unused native claim");
      },
    };
  });
});

const source: AgentDatabaseRequestExecutionSource = {
  assertCurrent() {},
  createAdmission() {
    throw new Error("Native workers are isolated in this lifecycle fixture");
  },
};

function capture(agentId: string) {
  return captureOpenClawAgentDatabaseExecution({ agentId, env });
}

async function use(agentId: string) {
  const execution = capture(agentId);
  await execution.prepare(source);
  await execution.release();
  return execution;
}

function closedAgents() {
  return opened.filter(({ close }) => close.mock.calls.length > 0).map(({ agentId }) => agentId);
}

it("opens only two executors for six alternating agent borrows", async () => {
  for (const agentId of ["first", "second", "first", "second", "first", "second"]) {
    await use(agentId);
  }
  expect(opened.map(({ agentId }) => agentId)).toEqual(["first", "second"]);
  expect(closedAgents()).toEqual([]);
});

it("evicts the least recently used idle executor when a fifth agent finishes", async () => {
  for (const agentId of ["first", "second", "third", "fourth", "first", "fifth"]) {
    await use(agentId);
  }
  expect(closedAgents()).toEqual(["second"]);
  await use("first");
  expect(opened).toHaveLength(5);
  await use("second");
  expect(opened).toHaveLength(6);
  expect(closedAgents()).toEqual(["second", "third"]);
});

it("keeps a shared creating owner out of idle eviction until its last borrower releases", async () => {
  const options = {
    agentId: "creating",
    env,
    path: path.join(env.OPENCLAW_STATE_DIR!, "creating.sqlite"),
  };
  const constraints = { expectedCreationIdentity: readDatabasePathIdentitySync(options.path) };
  const first = captureOpenClawAgentDatabaseExecution(options, constraints);
  const joining = captureOpenClawAgentDatabaseExecution(options, constraints);
  try {
    await first.prepare(source);
    await first.release();
    for (const agentId of ["first", "second", "third", "fourth", "fifth"]) {
      await use(agentId);
    }
    expect(closedAgents()).toEqual(["first"]);
    await joining.prepare(source);
    expect(opened.filter(({ agentId }) => agentId === "creating")).toHaveLength(1);
    const ordinary = captureOpenClawAgentDatabaseExecution(options);
    try {
      await expect(ordinary.prepare(source)).rejects.toThrow(/captured creating reference/);
    } finally {
      await ordinary.release();
    }
  } finally {
    await Promise.allSettled([first.release(), joining.release()]);
  }
});

it("expires each executor independently and refreshes only the borrowed one", async () => {
  await use("first");
  await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS / 2);
  await use("second");
  await use("first");
  await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS / 2);
  expect(closedAgents()).toEqual([]);
  await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS / 2);
  expect(closedAgents()).toEqual(["first", "second"]);
  await use("first");
  expect(opened).toHaveLength(3);
});

it.each(["shutdown", "restart drain"] as const)("closes all warm executors on %s", async (mode) => {
  for (const agentId of ["first", "second", "third", "fourth"]) {
    await use(agentId);
  }
  expect(closedAgents()).toEqual([]);
  if (mode === "restart drain") {
    markGatewayRestartDraining();
    await vi.advanceTimersByTimeAsync(0);
  } else {
    await closeOpenClawAgentDatabasesAsync();
  }
  expect(closedAgents()).toEqual(["first", "second", "third", "fourth"]);
  expect(opened.every(({ close }) => close.mock.calls.length === 1)).toBe(true);
});

it("retires only the selected physical store and shares its directory alias", async () => {
  const first = await use("first");
  await use("second");
  fs.mkdirSync(path.dirname(first.path), { recursive: true });
  const alias = path.join(env.OPENCLAW_STATE_DIR!, "alias");
  fs.symlinkSync(
    path.dirname(first.path),
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const borrowed = captureOpenClawAgentDatabaseExecution({
    agentId: "first",
    env,
    path: path.join(alias, path.basename(first.path)),
  });
  await borrowed.prepare(source);
  await borrowed.release();
  expect(opened).toHaveLength(2);
  await closeOpenClawAgentDatabaseByPathAsync(borrowed.path, "first");
  expect(closedAgents()).toEqual(["first"]);
  await use("first");
  await use("second");
  expect(opened.map(({ agentId }) => agentId)).toEqual(["first", "second", "first"]);
});

it("keeps a reborrow live while another idle executor is being evicted", async () => {
  for (const agentId of ["first", "second", "third", "fourth"]) {
    await use(agentId);
  }
  const evicting = createDeferredCore();
  const entered = createDeferredCore();
  const first = opened[0];
  assert(first);
  first.close.mockImplementationOnce(() => {
    entered.resolve();
    return evicting.promise;
  });
  const fifth = capture("fifth");
  await fifth.prepare(source);
  const releasing = fifth.release();
  await entered.promise;
  const borrowed = capture("fifth");
  evicting.resolve();
  await releasing;
  await borrowed.prepare(source);
  expect(opened).toHaveLength(5);
  expect(closedAgents()).toEqual(["first"]);
  await borrowed.release();
});

it("retains failed eviction custody without retaining a fifth idle executor", async () => {
  for (const agentId of ["first", "second", "third", "fourth"]) {
    await use(agentId);
  }
  const first = opened[0];
  assert(first);
  first.close.mockRejectedValueOnce(new Error("synthetic cleanup failure"));
  await use("fifth");
  expect(closedAgents()).toEqual(["first", "fifth"]);
  await use("sixth");
  expect(first.close).toHaveBeenCalledTimes(2);
  expect(closedAgents()).toEqual(["first", "fifth"]);
});

it.each(["removal", "rename", "agent path", "session path"] as const)(
  "retires affected warm executors after a committed agent %s change",
  async (change) => {
    const config: OpenClawConfig = { agents: { entries: { first: {}, second: {} } } };
    setRuntimeConfigSnapshot(config);
    await use("first");
    await use("second");
    // Publication supports in-place mutations; the executor must retain resolved values.
    if (change === "removal" || change === "rename") {
      config.agents!.entries = { second: {}, ...(change === "rename" ? { renamed: {} } : {}) };
    } else if (change === "agent path") {
      const first = config.agents!.entries!.first;
      assert(first);
      first.agentDir = path.join(env.OPENCLAW_STATE_DIR!, "relocated");
    } else {
      config.session = {
        store: path.join(env.OPENCLAW_STATE_DIR!, "relocated", "{agentId}.sqlite"),
      };
    }
    setRuntimeConfigSnapshot(config);
    await vi.advanceTimersByTimeAsync(0);
    expect(closedAgents()).toEqual(change === "session path" ? ["first", "second"] : ["first"]);
    await use("second");
    expect(opened).toHaveLength(change === "session path" ? 3 : 2);
  },
);

it("keeps warm executors through unrelated configuration publication", async () => {
  setRuntimeConfigSnapshot({ agents: { entries: { first: {}, second: {} } } });
  await use("first");
  await use("second");
  setRuntimeConfigSnapshot({
    agents: { entries: { first: { name: "New display name" }, second: {} } },
  });
  await use("first");
  await use("second");
  expect(opened).toHaveLength(2);
  expect(closedAgents()).toEqual([]);
});

it("admits a fresh borrower after config publication while fencing the old borrower and native close", async () => {
  const config: OpenClawConfig = { agents: { entries: { first: {} } } };
  setRuntimeConfigSnapshot(config);
  const previous = capture("first");
  await previous.prepare(source);
  const first = opened[0];
  assert(first);
  const closing = createDeferredCore();
  first.close.mockImplementation(() => closing.promise);
  let next: ReturnType<typeof capture> | undefined;
  try {
    setRuntimeConfigSnapshot({
      ...config,
      session: { store: path.join(env.OPENCLAW_STATE_DIR!, "relocated", "{agentId}.sqlite") },
    });
    expect(() => previous.assertCurrent()).toThrow("admission is closed");
    next = capture("first");
    let prepared = false;
    const preparing = next.prepare(source).then(() => {
      prepared = true;
    });
    await Promise.resolve();
    expect(prepared).toBe(false);
    expect(opened).toHaveLength(1);
    closing.resolve();
    await preparing;
    expect(opened).toHaveLength(2);
    expect(() => previous.assertCurrent()).toThrow("admission is closed");
    const staleCleanup = vi.fn(async () => undefined);
    await expect(
      previous.runExisting(source, staleCleanup, { retireNativeOnFailure: true }),
    ).rejects.toThrow("admission is closed");
    expect(staleCleanup).not.toHaveBeenCalled();
    expect(opened[1]?.close).not.toHaveBeenCalled();
    next.assertCurrent();
    setRuntimeConfigSnapshot(config);
    expect(() => next?.assertCurrent()).toThrow("admission is closed");
  } finally {
    closing.resolve();
    await previous.release();
    await next?.release();
  }
});
