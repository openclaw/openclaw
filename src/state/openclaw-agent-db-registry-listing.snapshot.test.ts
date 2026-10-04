import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
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

it("lazily reads in its captured scope and publishes complete rows to the canonical memo", async () => {
  const other = { path: "/fixture/other/state.sqlite" };
  const token = readOpenClawAgentDatabaseRegistryToken(other);
  const env = { ...options.env };
  const scope = new AsyncLocalStorage<string>();
  const prepared = scope.run("captured", () =>
    prepareOpenClawAgentDatabaseRegistrySnapshotRead({ ...options, env }),
  );
  env.OPENCLAW_STATE_DIR = "/fixture/changed";
  expect(mocks.capture).toHaveBeenCalledWith(
    expect.objectContaining({
      env: expect.objectContaining({ OPENCLAW_STATE_DIR: "/fixture/registry" }),
    }),
  );
  expect(readOpenClawAgentDatabaseRegistryToken(other)).toBe(token);
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
  expect(
    listOpenClawRegisteredAgentDatabases({ ...options, includeIncompatibleSchemaVersions: true }),
  ).toEqual([...entries, incompatible]);
  expect(mocks.read).toHaveBeenCalledOnce();
});

it.each(["capture", "reader"] as const)(
  "propagates %s failure when the registry is demanded",
  async (stage) => {
    const failure = new Error(`${stage} refused`);
    if (stage === "capture") {
      mocks.capture.mockImplementation(() => {
        throw failure;
      });
    } else {
      mocks.read.mockRejectedValueOnce(failure);
    }
    const prepared = prepareOpenClawAgentDatabaseRegistrySnapshotRead(options);
    expect(mocks.read).not.toHaveBeenCalled();
    await expect(prepared.read()).rejects.toBe(failure);
  },
);

it("retains scoped revocation before native registry rows are needed", async () => {
  const prepared = prepareOpenClawAgentDatabaseRegistrySnapshotRead(options, () => true);
  expect(() => prepared.assertCurrent()).not.toThrow();
  expect(mocks.read).not.toHaveBeenCalled();
  invalidateRegisteredAgentDatabasesMemo(options);
  expect(() => prepared.assertCurrent()).toThrow("registry changed");
  await expect(prepared.read()).rejects.toThrow("registry changed");
  expect(() => prepared.assertCurrent()).toThrow("registry changed");
  expect(mocks.read).not.toHaveBeenCalled();
});

it.each([false, true])(
  "follows only contiguous owned registry invalidations (scoped=%s)",
  async (scoped) => {
    const snapshot = await prepareOpenClawAgentDatabaseRegistrySnapshotRead(
      options,
      scoped ? () => true : undefined,
    ).read();
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
      const prepared = prepareOpenClawAgentDatabaseRegistrySnapshotRead(local);
      expect((await prepared.read()).result).toEqual({ status: "unavailable" });
      expect((await prepared.read()).result).toEqual({ status: "available", entries });
      expect(mocks.read).toHaveBeenCalledTimes(2);
    });
  },
);

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
