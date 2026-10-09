import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  readChannelPairingStateSnapshot,
  writeChannelPairingStateSnapshot,
} from "./pairing-store-sqlite.test-helpers.js";
import {
  addChannelAllowFromStoreEntry,
  approveChannelPairingCode,
  dismissChannelPairingRequest,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  removeChannelAllowFromStoreEntry,
  resolveChannelPairingRequestId,
  upsertChannelPairingRequest,
  type PairingRequest,
} from "./pairing-store.js";

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);
let root: string;
let env: NodeJS.ProcessEnv;
let database: ReturnType<typeof openOpenClawStateDatabase>;

beforeAll(() => {
  root = directories.make("pairing-mutation-worker-");
  env = { ...process.env, OPENCLAW_STATE_DIR: root };
  database = openOpenClawStateDatabase({ env });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function request(id: string, accountId = "alpha", createdAt = new Date().toISOString()) {
  return {
    id,
    code: "ABCDEFGH",
    createdAt,
    lastSeenAt: createdAt,
    meta: { accountId, approval: `allow-${id}` },
  };
}

function seed(channel: string, requests: PairingRequest[], allowFrom = {}) {
  writeChannelPairingStateSnapshot(channel, { version: 1, requests, allowFrom }, env);
}

it.each([
  { operation: "list", refusedStage: "transaction" },
  { operation: "list", refusedStage: "commit" },
  { operation: "approve", refusedStage: "transaction" },
  { operation: "approve", refusedStage: "commit" },
  { operation: "missing-approve", refusedStage: "commit" },
] as const)(
  "rolls back $operation when owner authority is revoked at $refusedStage",
  async ({ operation, refusedStage }) => {
    const channel = `revoked-${operation}-${refusedStage}`;
    const createdAt = operation === "list" ? "2020-01-01T00:00:00.000Z" : new Date().toISOString();
    seed(channel, operation === "missing-approve" ? [] : [request("alice", "alpha", createdAt)]);
    const before = readChannelPairingStateSnapshot(channel, env);
    let currentStage: workerAdmission.SqliteWorkerAdmissionRequest["stage"] | undefined;
    const original = workerAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        original((admission, grant) => {
          currentStage = admission.stage;
          admit(admission, grant);
        }, attachment),
    );
    const refusal = new Error("owner authority revoked");
    const assertCurrent = () => {
      if (currentStage === refusedStage) {
        throw refusal;
      }
    };
    await expect(
      operation === "list"
        ? listChannelPairingRequests(channel, env, undefined, assertCurrent)
        : approveChannelPairingCode({
            channel,
            code: "ABCDEFGH",
            env,
            assertCurrent,
            pairingAdapter: { idLabel: "peer", normalizeAllowEntry: (entry) => entry },
          }),
    ).rejects.toBe(refusal);
    expect(currentStage).toBe(refusedStage);
    expect(readChannelPairingStateSnapshot(channel, env)).toEqual(before);
  },
);

it("settles an accepted approval when authority is revoked after the commit grant", async () => {
  const channel = "accepted-approval";
  seed(channel, [request("alice")]);
  let revoked = false;
  const original = workerAdmission.createSqliteWorkerOperationAdmission;
  vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
    (admit, attachment) =>
      original((admission, grant) => {
        admit(admission, grant);
        if (admission.stage === "commit") {
          revoked = true;
        }
      }, attachment),
  );
  const result = approveChannelPairingCode({
    channel,
    code: "ABCDEFGH",
    env,
    pairingAdapter: { idLabel: "peer" },
    assertCurrent: () => {
      if (revoked) {
        throw new Error("owner revoked after accepting the approval");
      }
    },
  });
  await expect(result).resolves.toMatchObject({ id: "alice" });
  expect(revoked).toBe(true);
  expect(readChannelPairingStateSnapshot(channel, env)).toMatchObject({
    requests: [],
    allowFrom: { alpha: ["alice"] },
  });
});

it.each(["selected", "missing"] as const)(
  "retains native write authority for a %s host approval after preparation",
  async (selection) => {
    const channel = `supervision-${selection}`;
    seed(channel, selection === "selected" ? [request("alice")] : []);
    const before = readChannelPairingStateSnapshot(channel, env);
    const callerEnv = { ...env, OPENCLAW_SUPERVISOR_MODE: undefined };
    await listChannelPairingRequests(channel, callerEnv);
    const claim = () => {
      database.db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
        "gateway.supervision",
        JSON.stringify({
          version: 1,
          mode: "external",
          managerId: "pairing-fixture",
          claimedAt: 1,
        }),
        1,
      );
    };
    if (selection === "missing") {
      claim();
    }
    try {
      await expect(
        approveChannelPairingCode({
          channel,
          code: "ABCDEFGH",
          env: callerEnv,
          pairingAdapter: {
            idLabel: "peer",
            resolveApprovalStoreEntry: ({ id }) => {
              claim();
              return id;
            },
          },
        }),
      ).rejects.toThrow(/externally supervised by pairing-fixture/);
    } finally {
      database.db
        .prepare("DELETE FROM config_machine_state WHERE state_key = ?")
        .run("gateway.supervision");
    }
    expect(readChannelPairingStateSnapshot(channel, env)).toEqual(before);
  },
);

it("runs request, prune, approval, dismissal, and allowlist mutations without caller-thread SQL", async () => {
  const channel = "worker-boundary";
  const createdAt = new Date().toISOString();
  const dismissal = { ...request("dismiss", "alpha", createdAt), code: "BCDEFGHJ" };
  seed(
    channel,
    [
      request("approve", "alpha", createdAt),
      dismissal,
      request("expired", "alpha", "2020-01-01T00:00:00.000Z"),
    ],
    { alpha: ["keep", "remove"] },
  );
  const sql = observeHostDataSql();
  try {
    const pending = await listChannelPairingRequests(channel, env, "alpha");
    expect(pending.map((entry) => entry.id)).toEqual(["approve", "dismiss"]);
    const created = await upsertChannelPairingRequest({
      channel,
      id: "new",
      accountId: "alpha",
      env,
    });
    expect(created).toEqual({ code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{8}$/), created: true });
    await expect(
      upsertChannelPairingRequest({ channel, id: "new", accountId: "alpha", env }),
    ).resolves.toEqual({ code: created.code, created: false });
    await expect(
      addChannelAllowFromStoreEntry({ channel, accountId: "alpha", entry: "added", env }),
    ).resolves.toEqual({ changed: true, allowFrom: ["keep", "remove", "added"] });
    await expect(
      removeChannelAllowFromStoreEntry({ channel, accountId: "alpha", entry: "remove", env }),
    ).resolves.toEqual({ changed: true, allowFrom: ["keep", "added"] });
    await expect(
      approveChannelPairingCode({ channel, code: "ABCDEFGH", accountId: "alpha", env }),
    ).resolves.toMatchObject({ id: "approve" });
    await expect(
      dismissChannelPairingRequest({
        channel,
        accountId: "alpha",
        requestId: resolveChannelPairingRequestId(channel, dismissal),
        env,
      }),
    ).resolves.toMatchObject({ id: "dismiss" });
    expect(
      sql.queries.filter((query) => /channel_pairing_(?:requests|allow_entries)/.test(query)),
    ).toEqual([]);
  } finally {
    sql.restore();
  }
  expect(readChannelPairingStateSnapshot(channel, env)).toMatchObject({
    requests: [{ id: "new" }],
    allowFrom: { alpha: ["keep", "added", "approve"] },
  });
});

it("captures the physical store before yielding and preserves FIFO allowlist edits", async () => {
  const channel = "captured-store";
  const captured = { ...env };
  const first = addChannelAllowFromStoreEntry({
    channel,
    accountId: "alpha",
    entry: "first",
    env: captured,
  });
  captured.OPENCLAW_STATE_DIR = path.join(root, "replacement");
  const second = addChannelAllowFromStoreEntry({
    channel,
    accountId: "alpha",
    entry: "second",
    env,
  });
  await expect(first).resolves.toEqual({ changed: true, allowFrom: ["first"] });
  await expect(second).resolves.toEqual({ changed: true, allowFrom: ["first", "second"] });
  expect(fs.existsSync(captured.OPENCLAW_STATE_DIR)).toBe(false);
});

it("retains foreign rows and normalizes legacy account aliases on the next mutation", async () => {
  const channel = "foreign-normalization";
  seed(channel, [request("waiting")], { alpha: ["existing"], beta: ["untouched"] });
  await listChannelPairingRequests(channel, env);
  database.db
    .prepare(
      "UPDATE channel_pairing_allow_entries SET account_id = ' Alpha ', entry = ' foreign ' WHERE channel_key = ? AND account_id = 'alpha'",
    )
    .run(channel);
  database.db
    .prepare(
      "UPDATE channel_pairing_requests SET account_id = ' Alpha ', meta_json = ? WHERE channel_key = ?",
    )
    .run(JSON.stringify({ accountId: "wrong-account", approval: "foreign-proof" }), channel);
  await upsertChannelPairingRequest({ channel, id: "new", accountId: "gamma", env });
  const state = readChannelPairingStateSnapshot(channel, env);
  expect(state.requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "waiting",
        meta: { accountId: "alpha", approval: "foreign-proof" },
      }),
      expect.objectContaining({ id: "new", meta: { accountId: "gamma" } }),
    ]),
  );
  expect(state.allowFrom).toEqual({ alpha: ["foreign"], beta: ["untouched"] });
  expect(
    database.db
      .prepare(
        "SELECT account_id FROM channel_pairing_requests WHERE channel_key = ? ORDER BY account_id",
      )
      .all(channel),
  ).toEqual([{ account_id: "alpha" }, { account_id: "gamma" }]);
});

it("removes a legacy padded allow entry using its canonical sender id", async () => {
  const channel = "legacy-removal";
  seed(channel, [], { alpha: ["foreign", "keep"], beta: ["foreign"] });
  database.db
    .prepare(
      "UPDATE channel_pairing_allow_entries SET entry = ' foreign ' WHERE channel_key = ? AND account_id = 'alpha' AND entry = 'foreign'",
    )
    .run(channel);
  await expect(
    removeChannelAllowFromStoreEntry({ channel, accountId: "alpha", entry: "foreign", env }),
  ).resolves.toEqual({ changed: true, allowFrom: ["keep"] });
  await expect(readChannelAllowFromStore(channel, env, "alpha")).resolves.toEqual(["keep"]);
  await expect(readChannelAllowFromStore(channel, env, "beta")).resolves.toEqual(["foreign"]);
});

it.each(["error", "null", "revoked"] as const)(
  "preserves approval burn semantics when its adapter returns %s",
  async (outcome) => {
    const channel = `adapter-${outcome}`;
    seed(channel, [request("alice")], { alpha: ["existing"] });
    const before = readChannelPairingStateSnapshot(channel, env);
    const refusal = new Error("synthetic approval refused");
    let current = true;
    const result = approveChannelPairingCode({
      channel,
      accountId: "alpha",
      code: "ABCDEFGH",
      env,
      assertCurrent: () => {
        if (!current) {
          throw refusal;
        }
      },
      pairingAdapter: {
        idLabel: "peer",
        resolveApprovalStoreEntry: () => {
          if (outcome === "error") {
            throw refusal;
          }
          if (outcome === "revoked") {
            current = false;
            return "must-not-be-approved";
          }
          return null;
        },
      },
    });
    if (outcome === "null") {
      await expect(result).resolves.toMatchObject({ id: "alice" });
      expect(readChannelPairingStateSnapshot(channel, env)).toEqual({
        ...before,
        requests: [],
      });
    } else {
      await expect(result).rejects.toBe(refusal);
      expect(readChannelPairingStateSnapshot(channel, env)).toEqual(before);
    }
  },
);

it.each(["metadata", "earlier-match", "expired"] as const)(
  "rereads the selected request after a foreign %s change during approval preparation",
  async (change) => {
    const channel = `approval-race-${change}`;
    const first = request("alice", "alpha", new Date(Date.now() - 10_000).toISOString());
    seed(channel, [first]);
    let changed = false;
    const result = await approveChannelPairingCode({
      channel,
      code: "ABCDEFGH",
      env,
      pairingAdapter: {
        idLabel: "peer",
        resolveApprovalStoreEntry: ({ meta }) => {
          if (!changed) {
            changed = true;
            if (change === "metadata") {
              database.db
                .prepare("UPDATE channel_pairing_requests SET meta_json = ? WHERE channel_key = ?")
                .run(JSON.stringify({ accountId: "alpha", approval: "foreign-proof" }), channel);
            } else if (change === "expired") {
              database.db
                .prepare(
                  "UPDATE channel_pairing_requests SET created_at = '2020-01-01T00:00:00.000Z' WHERE channel_key = ?",
                )
                .run(channel);
            } else {
              const earlier = new Date(Date.now() - 20_000).toISOString();
              database.db
                .prepare(
                  "INSERT INTO channel_pairing_requests (channel_key, account_id, request_id, code, created_at, last_seen_at, meta_json) VALUES (?, 'beta', 'bob', 'ABCDEFGH', ?, ?, ?)",
                )
                .run(
                  channel,
                  earlier,
                  earlier,
                  JSON.stringify({ accountId: "beta", approval: "foreign-proof" }),
                );
            }
          }
          return meta?.approval ?? null;
        },
      },
    });
    expect(changed).toBe(true);
    if (change === "expired") {
      expect(result).toBeNull();
      expect(readChannelPairingStateSnapshot(channel, env)).toEqual({
        version: 1,
        requests: [],
        allowFrom: {},
      });
    } else {
      expect(result).toMatchObject({ id: change === "metadata" ? "alice" : "bob" });
      const accountId = change === "metadata" ? "alpha" : "beta";
      await expect(readChannelAllowFromStore(channel, env, accountId)).resolves.toEqual([
        "foreign-proof",
      ]);
      expect(
        readChannelPairingStateSnapshot(channel, env).requests.map((entry) => entry.id),
      ).toEqual(change === "metadata" ? [] : ["alice"]);
    }
  },
);
