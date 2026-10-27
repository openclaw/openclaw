import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as databaseProcessRole from "../infra/database-engine/admission-scope.js";
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
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import * as native from "./openclaw-agent-execution-native.js";
import {
  captureOpenClawAgentDatabaseExecution,
  getOpenClawAgentDatabaseCleanupFailures,
} from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";
import { resolveDatabasePath } from "./openclaw-state-db.paths.js";

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
      getPendingNativeOpen: () => undefined,
      getPendingPreparation: () => undefined,
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

function capture(agentId: string, pathname?: string) {
  return captureOpenClawAgentDatabaseExecution({ agentId, env, path: pathname });
}

async function use(agentId: string, ...following: string[]) {
  const execution = capture(agentId);
  await execution.prepare(source);
  await execution.release();
  for (const next of following) {
    await use(next);
  }
  return execution;
}

function closedAgents() {
  return opened.filter(({ close }) => close.mock.calls.length > 0).map(({ agentId }) => agentId);
}

const fillIdlePool = () => use("first", "second", "third", "fourth");

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
    await use("first", "second", "third", "fourth", "fifth");
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
  const first = await use("first");
  const terminal = vi.fn();
  first.onTerminal(terminal);
  await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS / 2);
  await use("second", "first");
  await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS / 2);
  expect(closedAgents()).toEqual([]);
  await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS / 2);
  expect(closedAgents()).toEqual(["first", "second"]);
  expect(terminal).not.toHaveBeenCalled();
  await use("first");
  expect(opened).toHaveLength(3);
});

it("retires a CLI one-shot's warm executor after the CLI window", async () => {
  vi.spyOn(databaseProcessRole, "getDatabaseProcessRole").mockReturnValue("cli-oneshot");
  await use("one-shot");
  await vi.advanceTimersByTimeAsync(30_000 - 1);
  expect(closedAgents()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(closedAgents()).toEqual(["one-shot"]);
});

it("closes all warm executors on restart drain", async () => {
  await fillIdlePool();
  expect(closedAgents()).toEqual([]);
  markGatewayRestartDraining();
  await vi.advanceTimersByTimeAsync(0);
  expect(closedAgents()).toEqual(["first", "second", "third", "fourth"]);
  expect(opened.every(({ close }) => close.mock.calls.length === 1)).toBe(true);
});

it("retains revoked cleanup diagnostics across physical aliases until retirement", async () => {
  const first = await use("first", "second");
  fs.mkdirSync(path.dirname(first.path), { recursive: true });
  const alias = path.join(env.OPENCLAW_STATE_DIR!, "alias");
  fs.symlinkSync(
    path.dirname(first.path),
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const borrowed = capture("first", path.join(alias, path.basename(first.path)));
  await borrowed.prepare(source);
  await borrowed.release();
  expect(opened).toHaveLength(2);
  const firstExecutor = opened[0];
  assert(firstExecutor);
  firstExecutor.close.mockRejectedValueOnce(new Error("controlled aliased cleanup failure"));
  await expect(closeOpenClawAgentDatabaseByPathAsync(borrowed.path, "first")).rejects.toThrow();
  const statePath = resolveDatabasePath({ env });
  expect(getOpenClawAgentDatabaseCleanupFailures(statePath)).toEqual([
    expect.objectContaining({
      agentId: "first",
      reason: expect.stringContaining("controlled aliased cleanup failure"),
      repairHint: expect.stringContaining("cannot retry on a request"),
    }),
  ]);
  expect(getOpenClawAgentDatabaseCleanupFailures(`${statePath}.other`)).toEqual([]);
  expect(() => capture("first")).toThrow("admission is closed");
  await closeOpenClawAgentDatabaseByPathAsync(borrowed.path, "first");
  expect(getOpenClawAgentDatabaseCleanupFailures(statePath)).toEqual([]);
  expect(closedAgents()).toEqual(["first"]);
});

it("keeps a reborrow live while another idle executor is being evicted", async () => {
  await fillIdlePool();
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

it("retains failed eviction custody without consuming healthy idle capacity", async () => {
  await fillIdlePool();
  const first = opened[0];
  assert(first);
  first.close.mockRejectedValueOnce(new Error("synthetic cleanup failure"));
  await use("fifth");
  expect(closedAgents()).toEqual(["first"]);
  for (const agentId of ["second", "fifth", "third", "fourth"]) {
    await use(agentId);
  }
  expect(opened).toHaveLength(5);
  expect(first.close).toHaveBeenCalledTimes(1);

  await use("first");
  expect(first.close).toHaveBeenCalledTimes(2);
  expect(opened).toHaveLength(6);
  expect(closedAgents()).toEqual(["first", "second"]);
});
