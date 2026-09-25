import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import {
  captureStateDatabaseCoordinatorRuntime,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import type { OpenClawAgentDatabaseRegistryReadResult } from "./openclaw-agent-db-contract.js";

const mocks = vi.hoisted(() => ({
  assertCurrent: vi.fn<() => void>(),
  capture: vi.fn<(options: { path?: string; env?: NodeJS.ProcessEnv }) => unknown>(),
  read: vi.fn<() => Promise<OpenClawAgentDatabaseRegistryReadResult | undefined>>(),
}));
vi.mock("./openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: (options: { path?: string; env?: NodeJS.ProcessEnv }) => {
    mocks.capture(options);
    return {
      admission: { assertCurrent: mocks.assertCurrent },
      coordinatorRuntime: { directory: "/fixture/captured-coordinator", keepAlive: false },
    };
  },
}));
vi.mock("./openclaw-state-db-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-db-readonly.js")>()),
  executeExistingOpenClawStateRead: async () => {
    const result = await mocks.read();
    return result === undefined
      ? undefined
      : { ok: true, type: "agentDatabaseRegistry.read", result };
  },
}));

import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  invalidateRegisteredAgentDatabasesMemo,
  listOpenClawRegisteredAgentDatabases,
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
  readOpenClawAgentDatabaseRegistryToken,
} from "./openclaw-agent-db-registry-listing.js";

const options = {
  path: "/fixture/registry/state.sqlite",
  env: { OPENCLAW_STATE_DIR: "/fixture/registry" },
};
const entry = {
  agentId: "main",
  path: "/fixture/main.sqlite",
  schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
  lastSeenAt: 1,
  sizeBytes: 2,
};
const entries = [entry];

beforeEach(() => {
  mocks.assertCurrent.mockReset();
  mocks.capture.mockReset();
  mocks.read.mockReset().mockResolvedValue({ status: "available", entries });
  invalidateRegisteredAgentDatabasesMemo(options);
});

it("captures authority without activating or reading an unused registry", () => {
  const other = { path: "/fixture/other/state.sqlite" };
  const token = readOpenClawAgentDatabaseRegistryToken(other);
  const env = { ...options.env };
  prepareOpenClawAgentDatabaseRegistrySnapshotRead({ ...options, env });
  env.OPENCLAW_STATE_DIR = "/fixture/changed";
  expect(mocks.capture).toHaveBeenCalledWith(
    expect.objectContaining({
      env: expect.objectContaining({ OPENCLAW_STATE_DIR: "/fixture/registry" }),
    }),
  );
  expect(readOpenClawAgentDatabaseRegistryToken(other)).toBe(token);
  expect(mocks.read).not.toHaveBeenCalled();
});

it("defers a capture refusal until the registry is actually demanded", async () => {
  const failure = new Error("capture refused");
  mocks.capture.mockImplementation(() => {
    throw failure;
  });
  const prepared = prepareOpenClawAgentDatabaseRegistrySnapshotRead(options);
  expect(mocks.read).not.toHaveBeenCalled();
  await expect(prepared.read()).rejects.toBe(failure);
});

it("publishes full successful rows into the existing canonical memo", async () => {
  const incompatible = {
    ...entry,
    agentId: "future",
    schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION + 1,
  };
  mocks.read.mockResolvedValue({ status: "available", entries: [...entries, incompatible] });
  const snapshot = await prepareOpenClawAgentDatabaseRegistrySnapshotRead(options).read();
  expect(snapshot.result).toEqual({ status: "available", entries });
  expect(
    listOpenClawRegisteredAgentDatabases({ ...options, includeIncompatibleSchemaVersions: true }),
  ).toEqual([...entries, incompatible]);
  expect(mocks.read).toHaveBeenCalledOnce();
});

it("follows only contiguous owned registry invalidations and keeps a refusal sticky", async () => {
  const snapshot = await prepareOpenClawAgentDatabaseRegistrySnapshotRead(options).read();
  const owned = invalidateRegisteredAgentDatabasesMemo(options);
  if (!owned) {
    throw new Error("Expected an active registry generation");
  }
  snapshot.followRegistration(owned);
  expect(() => snapshot.assertCurrent()).not.toThrow();

  invalidateRegisteredAgentDatabasesMemo(options);
  const later = invalidateRegisteredAgentDatabasesMemo(options);
  if (!later) {
    throw new Error("Expected another registry invalidation");
  }
  expect(() => snapshot.followRegistration(later)).toThrow(/invalidated registry/);
  expect(() => snapshot.followRegistration(owned)).toThrow(/invalidated registry/);
  expect(() => snapshot.assertCurrent()).toThrow(/registry changed/);
});

it("does not cache a certified unavailable read", async () => {
  mocks.read.mockResolvedValueOnce({ status: "unavailable" });
  const prepared = prepareOpenClawAgentDatabaseRegistrySnapshotRead(options);
  expect((await prepared.read()).result).toEqual({ status: "unavailable" });
  expect((await prepared.read()).result).toEqual({ status: "available", entries });
  expect(mocks.read).toHaveBeenCalledTimes(2);
});

it("does not cache an absent registry after its file appears before publication", async () => {
  await withTempDir("registry-absence-race-", async (stateDir) => {
    const local = {
      path: path.join(stateDir, "registry.sqlite"),
      env: { OPENCLAW_STATE_DIR: stateDir },
    };
    mocks.read.mockImplementationOnce(async () => {
      fs.writeFileSync(local.path, "synthetic newly created registry");
      return undefined;
    });
    const prepared = prepareOpenClawAgentDatabaseRegistrySnapshotRead(local);
    expect((await prepared.read()).result).toEqual({ status: "unavailable" });
    expect((await prepared.read()).result).toEqual({ status: "available", entries });
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
});

it.each(["authority", "memo"])("rejects unavailable facts after %s changes", async (kind) => {
  const failure = new Error("authority revoked");
  mocks.read.mockImplementationOnce(async () => {
    if (kind === "authority") {
      mocks.assertCurrent.mockImplementation(() => {
        throw failure;
      });
    } else {
      invalidateRegisteredAgentDatabasesMemo(options);
    }
    return { status: "unavailable" };
  });
  await expect(prepareOpenClawAgentDatabaseRegistrySnapshotRead(options).read()).rejects.toThrow(
    kind === "authority" ? failure : "registry changed",
  );
});

it("propagates an unsettled worker failure without producing an unavailable fact", async () => {
  const failure = new Error("reader retirement failed");
  mocks.read.mockRejectedValueOnce(failure);
  await expect(prepareOpenClawAgentDatabaseRegistrySnapshotRead(options).read()).rejects.toBe(
    failure,
  );
});

it("uses captured async scope and coordinator location when demand runs elsewhere", async () => {
  const scope = new AsyncLocalStorage<string>();
  const prepared = scope.run("captured", () =>
    prepareOpenClawAgentDatabaseRegistrySnapshotRead(options),
  );
  mocks.read.mockImplementationOnce(async () => {
    expect(scope.getStore()).toBe("captured");
    expect(captureStateDatabaseCoordinatorRuntime()).toEqual({
      directory: "/fixture/captured-coordinator",
      keepAlive: false,
    });
    return { status: "available", entries };
  });
  await scope.run("replacement", () =>
    withStateDatabaseCoordinatorRuntimeDirectory(
      { directory: "/fixture/replacement-coordinator", keepAlive: true },
      () => prepared.read(),
    ),
  );
});
