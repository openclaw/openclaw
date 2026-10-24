import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { generateUniqueCode } from "./pairing-store-model.js";

// mock-isolation: Store tests pass explicit adapters and must not discover installed channels.
vi.mock("../channels/plugins/pairing.js", () => ({
  getPairingAdapter: () => null,
}));

import {
  readChannelPairingStateSnapshot,
  writeChannelPairingStateSnapshot,
} from "./pairing-store-sqlite.test-helpers.js";
import {
  approveChannelPairingCode,
  dismissChannelPairingRequest,
  listChannelPairingRequests,
  readChannelAllowFromStoreSync,
  resolveChannelPairingRequestId,
} from "./pairing-store.js";
import { pairingStoreFixture } from "./pairing-store.test-support.js";

type PairingTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "channel_pairing_allow_entries" | "channel_pairing_requests"
>;

let fixtureRoot = "";
let pairingEnv: NodeJS.ProcessEnv;
let store: ReturnType<typeof pairingStoreFixture>;
beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", fixtureRoot));

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pairing-"));
  pairingEnv = { ...process.env, OPENCLAW_STATE_DIR: fixtureRoot };
  openOpenClawStateDatabase({ env: pairingEnv });
  store = pairingStoreFixture("telegram", pairingEnv);
});

afterAll(async () => {
  await closeStateDatabaseForTest();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  openOpenClawStateDatabase({ env: pairingEnv }).db.exec(
    "DELETE FROM channel_pairing_requests; DELETE FROM channel_pairing_allow_entries;",
  );
});

async function requestFor(accountId: string) {
  const requests = await store.list(accountId);
  expect(requests).toHaveLength(1);
  const request = requests[0];
  assert.ok(request, "expected pairing request");
  return request;
}

function writeAllowFromFixture(entries: string[]) {
  store.write({ version: 1, requests: [], allowFrom: { yy: entries } });
}

function upsert(id: string, accountId = DEFAULT_ACCOUNT_ID, channel = "telegram") {
  return pairingStoreFixture(channel, pairingEnv).upsert(id, accountId);
}

it("skips malformed persisted requests while approving valid codes", async () => {
  const env = pairingEnv;
  const database = openOpenClawStateDatabase({ env });
  const db = getNodeSqliteKysely<PairingTestDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db.insertInto("channel_pairing_requests").values([
      {
        channel_key: "telegram",
        account_id: DEFAULT_ACCOUNT_ID,
        request_id: "",
        code: "BADCODE1",
        created_at: "invalid",
        last_seen_at: "invalid",
        meta_json: null,
      },
      {
        channel_key: "telegram",
        account_id: "alpha",
        request_id: "valid-user",
        code: "GOODCODE",
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        meta_json: JSON.stringify({ accountId: "stale-account" }),
      },
    ]),
  );

  await expect(store.list("alpha")).resolves.toHaveLength(1);
  await expect(store.list("stale-account")).resolves.toEqual([]);
  await expect(
    approveChannelPairingCode({ channel: "telegram", accountId: "alpha", code: "GOODCODE", env }),
  ).resolves.toMatchObject({ id: "valid-user" });
  await expect(store.allow("alpha")).resolves.toEqual(["valid-user"]);
  await expect(store.allow("stale-account")).resolves.toEqual([]);
});

it("handles pending request reuse, expiry, and per-account limits", async () => {
  const env = pairingEnv;
  const first = await upsert("u1", DEFAULT_ACCOUNT_ID, "demo-a");
  const reused = await upsert("u1", DEFAULT_ACCOUNT_ID, "demo-a");
  expect(reused).toEqual({ code: first.code, created: false });

  const expired = await upsert("expired", DEFAULT_ACCOUNT_ID, "demo-b");
  expect(expired.created).toBe(true);
  const state = readChannelPairingStateSnapshot("demo-b", env);
  const expiredAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  state.requests = state.requests.map((request) => ({
    ...request,
    createdAt: expiredAt,
    lastSeenAt: expiredAt,
  }));
  writeChannelPairingStateSnapshot("demo-b", state, env);
  await expect(listChannelPairingRequests("demo-b", env)).resolves.toEqual([]);

  for (const id of ["one", "two", "three"]) {
    await expect(upsert(id, DEFAULT_ACCOUNT_ID, "demo-c")).resolves.toMatchObject({
      created: true,
    });
  }
  await expect(upsert("four", DEFAULT_ACCOUNT_ID, "demo-c")).resolves.toEqual({
    code: "",
    created: false,
  });
});

it("persists a channel-derived approval entry from request metadata", async () => {
  const fixture = pairingStoreFixture("demo-a", pairingEnv);
  const request = await fixture.upsert("alice", DEFAULT_ACCOUNT_ID, {
    proofEntry: "fixture-entry",
  });
  await expect(
    fixture.approve({
      code: request.code,
      resolveApprovalStoreEntry: ({ meta }) => meta?.proofEntry ?? null,
    }),
  ).resolves.toMatchObject({ id: "alice" });
  await expect(fixture.allow()).resolves.toEqual(["fixture-entry"]);
});

it("approves and dismisses account-scoped requests by opaque id", async () => {
  const env = pairingEnv;
  await upsert("shared-sender", "alpha");
  await upsert("shared-sender", "beta");
  const alphaRequest = await requestFor("alpha");
  const betaRequest = await requestFor("beta");
  const alphaChannel = " TeLeGrAm ";
  const alphaRequestId = resolveChannelPairingRequestId(alphaChannel, alphaRequest);
  const betaRequestId = resolveChannelPairingRequestId("telegram", betaRequest);

  expect(alphaRequestId).not.toBe(betaRequestId);
  expect(alphaRequestId).not.toContain(alphaRequest.code);
  await expect(store.approveRequest(alphaRequestId, "alpha", alphaChannel)).resolves.toMatchObject({
    id: "shared-sender",
  });
  await expect(store.allow("alpha")).resolves.toEqual(["shared-sender"]);
  await expect(store.approveRequest(alphaRequestId, "beta")).resolves.toBeNull();

  await expect(
    dismissChannelPairingRequest({
      channel: "telegram",
      accountId: "beta",
      requestId: betaRequestId,
    }),
  ).resolves.toMatchObject({ id: "shared-sender" });
  await expect(store.allow("beta")).resolves.toEqual([]);
  await expect(listChannelPairingRequests("telegram", env)).resolves.toEqual([]);
});

it("regenerates colliding codes and reports exhaustion without leaking codes", () => {
  const randomInt = vi.spyOn(crypto, "randomInt").mockImplementation(() => 0);
  expect(generateUniqueCode(new Set())).toBe("AAAAAAAA");

  let draws = 0;
  randomInt.mockImplementation(() => (draws++ < 8 ? 0 : 1));
  expect(generateUniqueCode(new Set(["AAAAAAAA"]))).toBe("BBBBBBBB");

  randomInt.mockImplementation(() => 0);
  expect(() => generateUniqueCode(new Set(["AAAAAAAA"]))).toThrow(
    "failed to generate unique pairing code after 500 attempts; existing code count: 1",
  );
});

it("keeps allowFrom and pending requests isolated by account", async () => {
  const env = pairingEnv;
  const alphaStore = pairingStoreFixture("telegram", env, "alpha");
  await alphaStore.add("1001");
  await expect(store.allow("alpha")).resolves.toEqual(["1001"]);
  await expect(store.allow("beta")).resolves.toEqual([]);

  const alpha = await upsert("shared", "alpha");
  const beta = await upsert("shared", "beta");
  expect(beta.code).not.toBe(alpha.code);
  expect((await requestFor("alpha")).code).toBe(alpha.code);
  expect((await requestFor("beta")).code).toBe(beta.code);

  await expect(
    approveChannelPairingCode({ channel: "telegram", code: alpha.code, env }),
  ).resolves.toMatchObject({ id: "shared" });
  await expect(store.allow("alpha")).resolves.toEqual(["1001", "shared"]);
  await expect(store.allow("beta")).resolves.toEqual([]);

  await expect(alphaStore.remove("1001")).resolves.toEqual({
    changed: true,
    allowFrom: ["shared"],
  });
});

it("reads current SQLite entries without a process-local file cache", async () => {
  const env = pairingEnv;
  writeAllowFromFixture(["1001"]);
  await expect(store.allow("yy")).resolves.toEqual(["1001"]);
  expect(readChannelAllowFromStoreSync("telegram", env, "yy")).toEqual(["1001"]);

  writeAllowFromFixture(["10022"]);
  await expect(store.allow("yy")).resolves.toEqual(["10022"]);
  const sql = observeHostDataSql();
  try {
    expect(readChannelAllowFromStoreSync("telegram", env, "yy")).toEqual(["10022"]);
    expect(sql.queries.filter((query) => query.includes("channel_pairing_requests"))).toEqual([]);
  } finally {
    sql.restore();
  }
});
