import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;

function key(name: string) {
  return `agent:main:dashboard:incognito-${name}`;
}

function create(name: string, category?: string) {
  return actor.sessions.create(authority, {
    sessionKey: key(name),
    entry: {
      sessionId: name,
      updatedAt: 10_000,
      createdAt: 10_000,
      lifecycleRevision: "initial",
      incognito: true,
      ...(category ? { category } : {}),
    },
  });
}

beforeAll(async () => {
  const root = tempDirs.make("incognito-side-data-");
  const target = path.join(root, "state");
  const alias = path.join(root, "state-alias");
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: alias },
    authority,
  });
  assert(opened);
  actor = opened;
});

afterAll(async () => {
  await actor?.close();
});

it("keeps readers usable after refusing a foreign sharing key", async () => {
  const sessionKey = key("foreign-key");
  await create("foreign-key");
  await expect(
    actor.sessions.sideData(authority, {
      type: "session.sharing.add",
      input: {
        sessionKey: "agent:sibling:dashboard:incognito-foreign",
        params: { identityId: "viewer", addedBy: "owner", addedAt: 12_000 },
      },
    }),
  ).rejects.toThrow("refusing non-canonical session key");
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.members.read",
      input: { sessionKey },
    }),
  ).toEqual([]);
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.progressCard.get",
      input: { sessionKey },
    }),
  ).toBeNull();
});

it("fences every category target during grants and rolls the whole batch back before commit", async () => {
  const names = ["batch-a", "batch-b"];
  const keys = names.map(key);
  await Promise.all(names.map((name) => create(name, "batch-category")));
  let allowed = true;
  const admitted: string[] = [];
  const source: IncognitoSessionAuthority = {
    assertCurrent() {
      if (!allowed) {
        throw new Error("category authority revoked");
      }
    },
    authorize(stage, facts) {
      for (const sessionKey of keys) {
        expect(() => actor.sessions.readSharing(sessionKey)).toThrow("pending or unavailable");
      }
      if (stage === "transaction") {
        admitted.push(facts.sessionKey);
      } else {
        allowed = false;
      }
    },
  };
  await expect(
    actor.sessions.sideData(source, {
      type: "session.category.apply",
      input: { from: "batch-category" },
    }),
  ).rejects.toThrow("category authority revoked");
  expect(admitted).toEqual(keys);
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.category.keys",
      input: { name: "batch-category" },
    }),
  ).toEqual(keys);
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.category.apply",
      input: { from: "batch-category" },
    }),
  ).toEqual(names.map((sessionId) => ({ sessionKey: key(sessionId), sessionId })));
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.category.keys",
      input: { name: "batch-category" },
    }),
  ).toEqual([]);
});

it("refuses stale disclosure after read authority is revoked", async () => {
  const names = ["revoked-read-a", "revoked-read-b"];
  const keys = names.map(key);
  await Promise.all(names.map((name) => create(name, "revoked-read")));
  let allowed = true;
  let executed = 0;
  const source: IncognitoSessionAuthority = {
    assertCurrent() {
      if (!allowed) {
        throw new Error("read authority revoked");
      }
    },
  };
  const original = workerStore.runSqliteWorkerStoreOperation;
  const observer = vi
    .spyOn(workerStore, "runSqliteWorkerStoreOperation")
    .mockImplementation(
      <Operations extends SqliteWorkerOperations, T>(
        target: SqliteWorkerStore<Operations>,
        operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
        stateContext?: Parameters<typeof original>[2],
        assertCurrent?: Parameters<typeof original>[3],
        createAdmission?: Parameters<typeof original>[4],
      ) =>
        original(
          target,
          (worker) =>
            operation({
              execute: async (command, options) => {
                const result = await worker.execute(command, options);
                executed++;
                allowed = false;
                return result;
              },
            }),
          stateContext,
          assertCurrent,
          createAdmission,
        ),
    );
  try {
    await expect(
      actor.sessions.sideData(source, {
        type: "session.catalog.read",
        input: { sessionKeys: keys },
      }),
    ).rejects.toThrow("read authority revoked");
    expect(executed).toBe(1);
  } finally {
    observer.mockRestore();
  }
  const catalog = await actor.sessions.sideData(authority, {
    type: "session.catalog.read",
    input: { sessionKeys: keys },
  });
  expect(catalog.map((row) => row[1])).toEqual(["revoked-read", "revoked-read"]);
  for (const sessionKey of keys) {
    expect(actor.sessions.readSharing(sessionKey)?.entry).toBeDefined();
  }
});
