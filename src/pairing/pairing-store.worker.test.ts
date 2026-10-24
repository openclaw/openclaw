import fs from "node:fs";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { resolveChannelPairingRequestId, type PairingRequest } from "./pairing-store.js";
import { pairingStoreFixture } from "./pairing-store.test-support.js";

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);
let root: string;
let env: NodeJS.ProcessEnv;
let database: ReturnType<typeof openOpenClawStateDatabase>;
beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", root));
beforeAll(() => {
  root = directories.make("pairing-mutation-worker-");
  env = { ...process.env, OPENCLAW_STATE_DIR: root };
  database = openOpenClawStateDatabase({ env });
});
afterEach(() => vi.restoreAllMocks());

function request(id: string, createdAt = new Date().toISOString()) {
  return {
    id,
    code: "ABCDEFGH",
    createdAt,
    lastSeenAt: createdAt,
    meta: { accountId: "alpha", approval: "allow-" + id },
  };
}
function fixture(
  channel: string,
  requests: PairingRequest[] = [],
  allowFrom = {},
  sourceEnv = env,
) {
  const store = pairingStoreFixture(channel, sourceEnv, "alpha");
  store.write({ version: 1, requests, allowFrom });
  return { ...store, before: store.read() };
}
function sql(query: string, ...values: SQLInputValue[]) {
  database.db.prepare(query).run(...values);
}

it.each([
  ["list", "transaction", false],
  ["list", "commit", false],
  ["approve", "transaction", false],
  ["approve", "commit", false],
  ["missing-approve", "commit", false],
  ["approve", "commit", true],
] as const)(
  "settles or rolls back %s when revoked at %s (grant accepted=%s)",
  async (operation, refusedStage, accepted) => {
    const createdAt = operation === "list" ? "2020-01-01T00:00:00.000Z" : new Date().toISOString();
    const f = fixture(
      "revoked-" + operation + "-" + refusedStage,
      operation === "missing-approve" ? [] : [request("alice", createdAt)],
    );
    let currentStage: workerAdmission.SqliteWorkerAdmissionRequest["stage"] | undefined;
    probe.admission(workerAdmission, (admission, grant, admit) => {
      if (!accepted) {
        currentStage = admission.stage;
      }
      admit(admission, grant);
      currentStage = admission.stage;
    });
    const refusal = new Error("owner authority revoked");
    const assertCurrent = () => {
      if (currentStage === refusedStage) {
        throw refusal;
      }
    };
    const result =
      operation === "list"
        ? f.list(undefined, assertCurrent)
        : f.approve({
            assertCurrent,
            pairingAdapter: {
              idLabel: "peer",
              normalizeAllowEntry: accepted ? undefined : (entry) => entry,
            },
          });
    if (accepted) {
      await expect(result).resolves.toMatchObject({ id: "alice" });
      expect(f.read()).toMatchObject({ requests: [], allowFrom: { alpha: ["alice"] } });
    } else {
      await expect(result).rejects.toBe(refusal);
      expect(f.read()).toEqual(f.before);
    }
    expect(currentStage).toBe(refusedStage);
  },
);

it.each(["selected", "missing"] as const)(
  "refuses a %s host approval after a committed ownership claim",
  async (selection) => {
    const channel = "supervision-" + selection;
    const callerEnv = {
      ...env,
      OPENCLAW_STATE_DIR: path.join(root, channel),
      OPENCLAW_SUPERVISOR_MODE: undefined,
    };
    const externalEnv = { ...callerEnv, OPENCLAW_SUPERVISOR_MODE: "external" };
    const f = fixture(channel, selection === "selected" ? [request("alice")] : [], {}, callerEnv);
    await f.list();
    const claim = () => claimOpenClawStateOwnership("pairing-fixture", { env: externalEnv });
    if (selection === "missing") {
      claim();
    }
    await expect(
      f.approve({
        resolveApprovalStoreEntry: ({ id }) => {
          claim();
          return id;
        },
      }),
    ).rejects.toThrow(/externally supervised by pairing-fixture/);
    expect(f.read(externalEnv)).toEqual(f.before);
  },
);

it("runs request, prune, approval, dismissal, and allowlist mutations without caller-thread SQL", async () => {
  const createdAt = new Date().toISOString();
  const dismissal = { ...request("dismiss", createdAt), code: "BCDEFGHJ" };
  const f = fixture(
    "worker-boundary",
    [request("approve", createdAt), dismissal, request("expired", "2020-01-01T00:00:00.000Z")],
    { alpha: ["keep", "remove"] },
  );
  const observed = observeHostDataSql();
  try {
    expect((await f.list("alpha")).map((entry) => entry.id)).toEqual(["approve", "dismiss"]);
    const created = await f.upsert("new");
    expect(created).toEqual({ code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{8}$/), created: true });
    await expect(f.upsert("new")).resolves.toEqual({ code: created.code, created: false });
    await expect(f.add("added")).resolves.toEqual({
      changed: true,
      allowFrom: ["keep", "remove", "added"],
    });
    await expect(f.remove("remove")).resolves.toEqual({
      changed: true,
      allowFrom: ["keep", "added"],
    });
    await expect(
      f.approve({ accountId: "alpha", pairingAdapter: undefined }),
    ).resolves.toMatchObject({ id: "approve" });
    await expect(
      f.dismiss(resolveChannelPairingRequestId("worker-boundary", dismissal)),
    ).resolves.toMatchObject({ id: "dismiss" });
    expect(
      observed.queries.filter((query) => /channel_pairing_(?:requests|allow_entries)/.test(query)),
    ).toEqual([]);
  } finally {
    observed.restore();
  }
  expect(f.read()).toMatchObject({
    requests: [{ id: "new" }],
    allowFrom: { alpha: ["keep", "added", "approve"] },
  });
});

it("captures the physical store before yielding and preserves FIFO allowlist edits", async () => {
  const f = fixture("captured-store");
  const captured = { ...env };
  const first = f.add("first", captured);
  captured.OPENCLAW_STATE_DIR = path.join(root, "replacement");
  const second = f.add("second");
  await expect(first).resolves.toEqual({ changed: true, allowFrom: ["first"] });
  await expect(second).resolves.toEqual({ changed: true, allowFrom: ["first", "second"] });
  expect(fs.existsSync(captured.OPENCLAW_STATE_DIR)).toBe(false);
});

it("removes a legacy padded allow entry using its canonical sender id", async () => {
  const channel = "legacy-removal";
  const f = fixture(channel, [], { alpha: ["foreign", "keep"], beta: ["foreign"] });
  sql(
    "UPDATE channel_pairing_allow_entries SET entry = ' foreign ' WHERE channel_key = ? AND account_id = 'alpha' AND entry = 'foreign'",
    channel,
  );
  await expect(f.remove("foreign")).resolves.toEqual({ changed: true, allowFrom: ["keep"] });
  await expect(f.allow("alpha")).resolves.toEqual(["keep"]);
  await expect(f.allow("beta")).resolves.toEqual(["foreign"]);
});

it.each(["error", "null", "revoked"] as const)(
  "preserves approval burn semantics when its adapter returns %s",
  async (outcome) => {
    const f = fixture("adapter-" + outcome, [request("alice")], { alpha: ["existing"] });
    const refusal = new Error("synthetic approval refused");
    let current = true;
    const result = f.approve({
      accountId: "alpha",
      assertCurrent: () => {
        if (!current) {
          throw refusal;
        }
      },
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
    });
    if (outcome === "null") {
      await expect(result).resolves.toMatchObject({ id: "alice" });
      expect(f.read()).toEqual({ ...f.before, requests: [] });
    } else {
      await expect(result).rejects.toBe(refusal);
      expect(f.read()).toEqual(f.before);
    }
  },
);

it.each(["metadata", "earlier-match", "expired"] as const)(
  "rereads the selected request after a foreign %s change during approval preparation",
  async (change) => {
    const channel = "approval-race-" + change;
    const f = fixture(channel, [request("alice", new Date(Date.now() - 10_000).toISOString())]);
    const accountId = change === "earlier-match" ? "beta" : "alpha";
    const proof = JSON.stringify({ accountId, approval: "foreign-proof" });
    let changed = false;
    const result = await f.approve({
      resolveApprovalStoreEntry: ({ meta }) => {
        if (!changed) {
          changed = true;
          if (change === "earlier-match") {
            const earlier = new Date(Date.now() - 20_000).toISOString();
            sql(
              "INSERT INTO channel_pairing_requests (channel_key, account_id, request_id, code, created_at, last_seen_at, meta_json) VALUES (?, 'beta', 'bob', 'ABCDEFGH', ?, ?, ?)",
              channel,
              earlier,
              earlier,
              proof,
            );
          } else {
            const column = change === "metadata" ? "meta_json" : "created_at";
            const value = change === "metadata" ? proof : "2020-01-01T00:00:00.000Z";
            sql(
              `UPDATE channel_pairing_requests SET ${column} = ? WHERE channel_key = ?`,
              value,
              channel,
            );
          }
        }
        return meta?.approval ?? null;
      },
    });
    expect(changed).toBe(true);
    if (change === "expired") {
      expect(result).toBeNull();
      expect(f.read()).toEqual({ version: 1, requests: [], allowFrom: {} });
    } else {
      expect(result).toMatchObject({ id: change === "metadata" ? "alice" : "bob" });
      await expect(f.allow(accountId)).resolves.toEqual(["foreign-proof"]);
      expect(f.read().requests.map((entry) => entry.id)).toEqual(
        change === "metadata" ? [] : ["alice"],
      );
    }
  },
);
