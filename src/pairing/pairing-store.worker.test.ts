import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
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

afterEach(() => vi.restoreAllMocks());

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

function snapshot(channel: string, sourceEnv = env) {
  return readChannelPairingStateSnapshot(channel, sourceEnv);
}

function scope(channel: string) {
  return { channel, env, accountId: "alpha" };
}

function approve(
  channel: string,
  options: Omit<Parameters<typeof approveChannelPairingCode>[0], "channel" | "code"> = {},
) {
  return approveChannelPairingCode({
    channel,
    code: "ABCDEFGH",
    env,
    pairingAdapter: { idLabel: "peer" },
    ...options,
  });
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
    const before = snapshot(channel);
    let currentStage: workerAdmission.SqliteWorkerAdmissionRequest["stage"] | undefined;
    probe.admission(workerAdmission, (admission, grant, admit) => {
      currentStage = admission.stage;
      admit(admission, grant);
    });
    const refusal = new Error("owner authority revoked");
    const assertCurrent = () => {
      if (currentStage === refusedStage) {
        throw refusal;
      }
    };
    await expect(
      operation === "list"
        ? listChannelPairingRequests(channel, env, undefined, assertCurrent)
        : approve(channel, {
            assertCurrent,
            pairingAdapter: { idLabel: "peer", normalizeAllowEntry: (entry) => entry },
          }),
    ).rejects.toBe(refusal);
    expect(currentStage).toBe(refusedStage);
    expect(snapshot(channel)).toEqual(before);
  },
);

it("settles an accepted approval when authority is revoked after the commit grant", async () => {
  const channel = "accepted-approval";
  seed(channel, [request("alice")]);
  let revoked = false;
  probe.admission(workerAdmission, (admission, grant, admit) => {
    admit(admission, grant);
    if (admission.stage === "commit") {
      revoked = true;
    }
  });
  const result = approve(channel, {
    assertCurrent: () => {
      if (revoked) {
        throw new Error("owner revoked after accepting the approval");
      }
    },
  });
  await expect(result).resolves.toMatchObject({ id: "alice" });
  expect(revoked).toBe(true);
  expect(snapshot(channel)).toMatchObject({
    requests: [],
    allowFrom: { alpha: ["alice"] },
  });
});

it.each(["selected", "missing"] as const)(
  "refuses a %s host approval after a committed ownership claim",
  async (selection) => {
    const channel = `supervision-${selection}`;
    const callerEnv = {
      ...env,
      OPENCLAW_STATE_DIR: path.join(root, channel),
      OPENCLAW_SUPERVISOR_MODE: undefined,
    };
    const externalEnv = { ...callerEnv, OPENCLAW_SUPERVISOR_MODE: "external" };
    writeChannelPairingStateSnapshot(
      channel,
      { version: 1, requests: selection === "selected" ? [request("alice")] : [], allowFrom: {} },
      callerEnv,
    );
    const before = snapshot(channel, callerEnv);
    await listChannelPairingRequests(channel, callerEnv);
    const claim = () => claimOpenClawStateOwnership("pairing-fixture", { env: externalEnv });
    if (selection === "missing") {
      claim();
    }
    await expect(
      approve(channel, {
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
    expect(snapshot(channel, externalEnv)).toEqual(before);
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
    const created = await upsertChannelPairingRequest({ ...scope(channel), id: "new" });
    expect(created).toEqual({ code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{8}$/), created: true });
    await expect(upsertChannelPairingRequest({ ...scope(channel), id: "new" })).resolves.toEqual({
      code: created.code,
      created: false,
    });
    await expect(
      addChannelAllowFromStoreEntry({ ...scope(channel), entry: "added" }),
    ).resolves.toEqual({ changed: true, allowFrom: ["keep", "remove", "added"] });
    await expect(
      removeChannelAllowFromStoreEntry({ ...scope(channel), entry: "remove" }),
    ).resolves.toEqual({ changed: true, allowFrom: ["keep", "added"] });
    await expect(
      approve(channel, { accountId: "alpha", pairingAdapter: undefined }),
    ).resolves.toMatchObject({
      id: "approve",
    });
    await expect(
      dismissChannelPairingRequest({
        ...scope(channel),
        requestId: resolveChannelPairingRequestId(channel, dismissal),
      }),
    ).resolves.toMatchObject({ id: "dismiss" });
    expect(
      sql.queries.filter((query) => /channel_pairing_(?:requests|allow_entries)/.test(query)),
    ).toEqual([]);
  } finally {
    sql.restore();
  }
  expect(snapshot(channel)).toMatchObject({
    requests: [{ id: "new" }],
    allowFrom: { alpha: ["keep", "added", "approve"] },
  });
});

it("captures the physical store before yielding and preserves FIFO allowlist edits", async () => {
  const channel = "captured-store";
  const captured = { ...env };
  const first = addChannelAllowFromStoreEntry({
    ...scope(channel),
    entry: "first",
    env: captured,
  });
  captured.OPENCLAW_STATE_DIR = path.join(root, "replacement");
  const second = addChannelAllowFromStoreEntry({ ...scope(channel), entry: "second" });
  await expect(first).resolves.toEqual({ changed: true, allowFrom: ["first"] });
  await expect(second).resolves.toEqual({ changed: true, allowFrom: ["first", "second"] });
  expect(fs.existsSync(captured.OPENCLAW_STATE_DIR)).toBe(false);
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
    removeChannelAllowFromStoreEntry({ ...scope(channel), entry: "foreign" }),
  ).resolves.toEqual({ changed: true, allowFrom: ["keep"] });
  await expect(readChannelAllowFromStore(channel, env, "alpha")).resolves.toEqual(["keep"]);
  await expect(readChannelAllowFromStore(channel, env, "beta")).resolves.toEqual(["foreign"]);
});

it.each(["error", "null", "revoked"] as const)(
  "preserves approval burn semantics when its adapter returns %s",
  async (outcome) => {
    const channel = `adapter-${outcome}`;
    seed(channel, [request("alice")], { alpha: ["existing"] });
    const before = snapshot(channel);
    const refusal = new Error("synthetic approval refused");
    let current = true;
    const result = approve(channel, {
      accountId: "alpha",
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
      expect(snapshot(channel)).toEqual({ ...before, requests: [] });
    } else {
      await expect(result).rejects.toBe(refusal);
      expect(snapshot(channel)).toEqual(before);
    }
  },
);

it.each(["metadata", "earlier-match", "expired"] as const)(
  "rereads the selected request after a foreign %s change during approval preparation",
  async (change) => {
    const channel = `approval-race-${change}`;
    seed(channel, [request("alice", "alpha", new Date(Date.now() - 10_000).toISOString())]);
    let changed = false;
    const result = await approve(channel, {
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
      expect(snapshot(channel)).toEqual({ version: 1, requests: [], allowFrom: {} });
    } else {
      expect(result).toMatchObject({ id: change === "metadata" ? "alice" : "bob" });
      const accountId = change === "metadata" ? "alpha" : "beta";
      await expect(readChannelAllowFromStore(channel, env, accountId)).resolves.toEqual([
        "foreign-proof",
      ]);
      expect(snapshot(channel).requests.map((entry) => entry.id)).toEqual(
        change === "metadata" ? [] : ["alice"],
      );
    }
  },
);
