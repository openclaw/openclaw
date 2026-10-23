import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import type { OpenClawAgentDatabaseRegistryReadResult } from "./openclaw-agent-db-contract.js";

const mocks = vi.hoisted(() => ({
  assertCurrent: vi.fn<() => void>(),
  capture: vi.fn<(options: { path?: string; env?: NodeJS.ProcessEnv }) => unknown>(),
  read: vi.fn<() => Promise<OpenClawAgentDatabaseRegistryReadResult | undefined>>(),
}));
// mock-isolation: Exercise snapshot admission with controlled receipts, not a live worker context.
vi.mock("./openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: (options: { path?: string; env?: NodeJS.ProcessEnv }) => {
    mocks.capture(options);
    return { admission: { assertCurrent: mocks.assertCurrent } };
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
  invalidateRegisteredAgentDatabasesMemo as invalidateMemo,
  listOpenClawRegisteredAgentDatabases as listDatabases,
  prepareOpenClawAgentDatabaseRegistrySnapshotRead as prepareRead,
  readOpenClawAgentDatabaseRegistryToken as readToken,
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
  invalidateMemo(options);
});

it("lazily reads in its captured scope and publishes complete rows to the canonical memo", async () => {
  const other = { path: "/fixture/other/state.sqlite" };
  const token = readToken(other);
  const env = { ...options.env };
  const scope = new AsyncLocalStorage<string>();
  const prepared = scope.run("captured", () => prepareRead({ ...options, env }));
  env.OPENCLAW_STATE_DIR = "/fixture/changed";
  expect(mocks.capture.mock.calls[0]?.[0]).toMatchObject({ env: options.env });
  expect(readToken(other)).toBe(token);
  expect(mocks.read).not.toHaveBeenCalled();
  const incompatible = {
    ...entry,
    agentId: "future",
    schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION + 1,
  };
  mocks.read.mockImplementationOnce(async () => {
    expect(scope.getStore()).toBe("captured");
    return { status: "available", entries: [...entries, incompatible] };
  });
  const snapshot = await scope.run("replacement", () => prepared.read());
  expect(snapshot.result).toEqual({ status: "available", entries });
  expect(listDatabases({ ...options, includeIncompatibleSchemaVersions: true })).toEqual([
    ...entries,
    incompatible,
  ]);
  expect(mocks.read).toHaveBeenCalledOnce();
});

it.each(["capture", "reader", "authority"] as const)(
  "propagates %s failure when the registry is demanded",
  async (stage) => {
    const failure = new Error(`${stage} refused`);
    if (stage === "capture") {
      mocks.capture.mockImplementation(() => {
        throw failure;
      });
    } else if (stage === "reader") {
      mocks.read.mockRejectedValueOnce(failure);
    } else {
      mocks.read.mockImplementationOnce(async () => {
        mocks.assertCurrent.mockImplementation(() => {
          throw failure;
        });
        return { status: "unavailable" };
      });
    }
    const prepared = prepareRead(options);
    expect(mocks.read).not.toHaveBeenCalled();
    await expect(prepared.read()).rejects.toBe(failure);
  },
);

it("inspects fresh registry rows without replacing the publication memo or its witnesses", async () => {
  const retained = prepareRead(options, () => false);
  await retained.read();
  const foreign = { ...entry, agentId: "foreign", path: "/fixture/foreign.sqlite" };
  mocks.read.mockResolvedValue({ status: "available", entries: [foreign] });
  const inspected = await prepareRead({ ...options, fresh: true }).read();
  expect(inspected.result).toEqual({ status: "available", entries: [foreign] });
  expect(() => inspected.assertCurrent()).not.toThrow();
  expect(() => retained.assertCurrent()).not.toThrow();
  expect((await retained.read()).result).toEqual({ status: "available", entries });
});

it("retains scoped revocation before native registry rows are needed", async () => {
  const prepared = prepareRead(options, () => true);
  expect(() => prepared.assertCurrent()).not.toThrow();
  expect(mocks.read).not.toHaveBeenCalled();
  invalidateMemo(options);
  expect(() => prepared.assertCurrent()).toThrow("registry changed");
  await expect(prepared.read()).rejects.toThrow("registry changed");
  expect(() => prepared.assertCurrent()).toThrow("registry changed");
  expect(mocks.read).not.toHaveBeenCalled();
});

it.each([false, true])(
  "follows only contiguous owned registry invalidations (scoped=%s)",
  async (scoped) => {
    const snapshot = await prepareRead(options, scoped ? () => true : undefined).read();
    const owned = invalidateMemo(options);
    assert(owned, "Expected an active registry generation");
    snapshot.followRegistration(owned);
    expect(() => snapshot.assertCurrent()).not.toThrow();

    invalidateMemo(options);
    const later = invalidateMemo(options);
    assert(later, "Expected another registry invalidation");
    expect(() => snapshot.followRegistration(later)).toThrow(/invalidated registry/);
    expect(() => snapshot.followRegistration(owned)).toThrow(/invalidated registry/);
    expect(() => snapshot.assertCurrent()).toThrow(/registry changed/);
  },
);

it.each(["unavailable", "appeared"] as const)(
  "does not memoize a registry that is %s before publication",
  async (state) => {
    await withTempDir("registry-absence-race-", async (stateDir) => {
      const local = {
        path: path.join(stateDir, "registry.sqlite"),
        env: { OPENCLAW_STATE_DIR: stateDir },
      };
      mocks.read.mockImplementationOnce(async () => {
        if (state === "unavailable") {
          return { status: "unavailable" };
        }
        fs.writeFileSync(local.path, "synthetic newly created registry");
        return undefined;
      });
      const prepared = prepareRead(local);
      expect((await prepared.read()).result).toEqual({ status: "unavailable" });
      expect((await prepared.read()).result).toEqual({ status: "available", entries });
      expect(mocks.read).toHaveBeenCalledTimes(2);
    });
  },
);

it("reads separate registries without retrying against another database's memo", async () => {
  const firstReply = createDeferred<OpenClawAgentDatabaseRegistryReadResult>();
  const secondReply = createDeferred<OpenClawAgentDatabaseRegistryReadResult>();
  mocks.read
    .mockImplementationOnce(() => firstReply.promise)
    .mockImplementationOnce(() => secondReply.promise)
    .mockRejectedValue(new Error("Unexpected retry without a registry publication"));
  const first = prepareRead(options).read();
  const second = prepareRead({ path: "/fixture/other/state.sqlite" }).read();
  try {
    firstReply.resolve({ status: "available", entries });
    const snapshot = await first;
    expect(snapshot.result).toEqual({ status: "available", entries });
    expect(snapshot.assertCurrent).toThrow("registry changed");
    secondReply.resolve({ status: "available", entries: [] });
    await expect(second).resolves.toMatchObject({ result: { status: "available", entries: [] } });
    expect(mocks.read).toHaveBeenCalledTimes(2);
  } finally {
    firstReply.resolve({ status: "available", entries });
    secondReply.resolve({ status: "available", entries: [] });
    await Promise.allSettled([first, second]);
  }
});
