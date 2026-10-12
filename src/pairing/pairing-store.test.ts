// Tests SQLite-backed pairing store lifecycle and account isolation.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { generateUniqueCode } from "./pairing-store-model.js";

const pairingMocks = vi.hoisted(() => ({
  getPairingAdapter: vi.fn<
    () => { idLabel: string; normalizeAllowEntry?: (entry: string) => string } | null
  >(() => null),
}));

vi.mock("../channels/plugins/pairing.js", () => ({
  getPairingAdapter: pairingMocks.getPairingAdapter,
}));

import {
  readChannelPairingStateSnapshot,
  writeChannelPairingStateSnapshot,
} from "./pairing-store-sqlite.test-helpers.js";
import {
  addChannelAllowFromStoreEntry,
  approveChannelPairingCode,
  approveChannelPairingRequest,
  dismissChannelPairingRequest,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  readChannelAllowFromStoreSync,
  removeChannelAllowFromStoreEntry,
  resolveChannelPairingRequestId,
  upsertChannelPairingRequest,
} from "./pairing-store.js";

type PairingTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "channel_pairing_allow_entries" | "channel_pairing_requests"
>;

let fixtureRoot = "";
let pairingEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pairing-"));
  pairingEnv = { ...process.env, OPENCLAW_STATE_DIR: fixtureRoot };
  openOpenClawStateDatabase({ env: pairingEnv });
});

afterAll(async () => {
  await closeStateDatabaseForTest();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  pairingMocks.getPairingAdapter.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  openOpenClawStateDatabase({ env: pairingEnv }).db.exec(
    "DELETE FROM channel_pairing_requests; DELETE FROM channel_pairing_allow_entries;",
  );
});

function requireFirstPairingRequest(
  requests: Awaited<ReturnType<typeof listChannelPairingRequests>>,
) {
  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (!request) {
    throw new Error("expected pairing request");
  }
  return request;
}

function writeAllowFromFixture(params: {
  env: NodeJS.ProcessEnv;
  channel: string;
  accountId?: string;
  allowFrom: string[];
}) {
  const state = readChannelPairingStateSnapshot(params.channel, params.env);
  state.allowFrom ??= {};
  state.allowFrom[params.accountId ?? DEFAULT_ACCOUNT_ID] = params.allowFrom;
  writeChannelPairingStateSnapshot(params.channel, state, params.env);
}

describe("pairing store", () => {
  it("normalizes allowlist entries through channel pairing adapters", async () => {
    const env = pairingEnv;
    pairingMocks.getPairingAdapter.mockReturnValue({
      idLabel: "Telegram user",
      normalizeAllowEntry: (entry) => entry.replace(/^telegram:/i, ""),
    });

    await expect(
      addChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "yy",
        entry: "telegram:1001",
        env,
      }),
    ).resolves.toEqual({ changed: true, allowFrom: ["1001"] });
    await expect(readChannelAllowFromStore("telegram", env, "yy")).resolves.toEqual(["1001"]);

    const directAdapter = {
      idLabel: "Direct",
      normalizeAllowEntry: (entry: string) => entry.replace(/^direct:/i, ""),
    };
    await expect(
      addChannelAllowFromStoreEntry({
        channel: "external-channel",
        accountId: "main",
        entry: "direct:42",
        env,
        pairingAdapter: directAdapter,
      }),
    ).resolves.toEqual({ changed: true, allowFrom: ["42"] });
  });

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

    await expect(listChannelPairingRequests("telegram", env, "alpha")).resolves.toHaveLength(1);
    await expect(listChannelPairingRequests("telegram", env, "stale-account")).resolves.toEqual([]);
    await expect(
      approveChannelPairingCode({ channel: "telegram", accountId: "alpha", code: "GOODCODE", env }),
    ).resolves.toMatchObject({ id: "valid-user" });
    await expect(readChannelAllowFromStore("telegram", env, "alpha")).resolves.toEqual([
      "valid-user",
    ]);
    await expect(readChannelAllowFromStore("telegram", env, "stale-account")).resolves.toEqual([]);
  });

  it("handles pending request reuse, expiry, and per-account limits", async () => {
    const env = pairingEnv;
    const first = await upsertChannelPairingRequest({
      channel: "demo-a",
      id: "u1",
      accountId: DEFAULT_ACCOUNT_ID,
      env,
    });
    const reused = await upsertChannelPairingRequest({
      channel: "demo-a",
      id: "u1",
      accountId: DEFAULT_ACCOUNT_ID,
      env,
    });
    expect(reused).toEqual({ code: first.code, created: false });

    const expired = await upsertChannelPairingRequest({
      channel: "demo-b",
      id: "expired",
      accountId: DEFAULT_ACCOUNT_ID,
      env,
    });
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
      await expect(
        upsertChannelPairingRequest({
          channel: "demo-c",
          id,
          accountId: DEFAULT_ACCOUNT_ID,
          env,
        }),
      ).resolves.toMatchObject({ created: true });
    }
    await expect(
      upsertChannelPairingRequest({
        channel: "demo-c",
        id: "four",
        accountId: DEFAULT_ACCOUNT_ID,
        env,
      }),
    ).resolves.toEqual({ code: "", created: false });
  });

  it("persists a channel-derived approval entry from request metadata", async () => {
    const env = pairingEnv;
    const request = await upsertChannelPairingRequest({
      channel: "demo-a",
      id: "alice",
      accountId: DEFAULT_ACCOUNT_ID,
      meta: { proofEntry: "fixture-entry" },
      env,
    });
    const pairingAdapter = {
      idLabel: "peer",
      normalizeAllowEntry: (entry: string) => entry,
      resolveApprovalStoreEntry: ({ meta }: { meta?: Record<string, string> }) =>
        meta?.proofEntry ?? null,
    };

    await expect(
      approveChannelPairingCode({
        channel: "demo-a",
        code: request.code,
        env,
        pairingAdapter,
      }),
    ).resolves.toMatchObject({ id: "alice" });
    await expect(readChannelAllowFromStore("demo-a", env)).resolves.toEqual(["fixture-entry"]);
  });

  it("approves and dismisses account-scoped requests by opaque id", async () => {
    const env = pairingEnv;
    await upsertChannelPairingRequest({
      channel: "telegram",
      accountId: "alpha",
      id: "shared-sender",
      env,
    });
    await upsertChannelPairingRequest({
      channel: "telegram",
      accountId: "beta",
      id: "shared-sender",
      env,
    });
    const alphaRequest = requireFirstPairingRequest(
      await listChannelPairingRequests("telegram", env, "alpha"),
    );
    const betaRequest = requireFirstPairingRequest(
      await listChannelPairingRequests("telegram", env, "beta"),
    );
    const alphaChannel = " TeLeGrAm ";
    const alphaRequestId = resolveChannelPairingRequestId(alphaChannel, alphaRequest);
    const betaRequestId = resolveChannelPairingRequestId("telegram", betaRequest);

    expect(alphaRequestId).not.toBe(betaRequestId);
    expect(alphaRequestId).not.toContain(alphaRequest.code);
    await expect(
      approveChannelPairingRequest({
        channel: alphaChannel,
        accountId: "alpha",
        requestId: alphaRequestId,
        env,
      }),
    ).resolves.toMatchObject({ id: "shared-sender" });
    await expect(readChannelAllowFromStore("telegram", env, "alpha")).resolves.toEqual([
      "shared-sender",
    ]);
    await expect(
      approveChannelPairingRequest({
        channel: "telegram",
        accountId: "beta",
        requestId: alphaRequestId,
        env,
      }),
    ).resolves.toBeNull();

    await expect(
      dismissChannelPairingRequest({
        channel: "telegram",
        accountId: "beta",
        requestId: betaRequestId,
        env,
      }),
    ).resolves.toMatchObject({ id: "shared-sender" });
    await expect(readChannelAllowFromStore("telegram", env, "beta")).resolves.toEqual([]);
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
    await addChannelAllowFromStoreEntry({
      channel: "telegram",
      accountId: "alpha",
      entry: "1001",
      env,
    });
    await expect(readChannelAllowFromStore("telegram", env, "alpha")).resolves.toEqual(["1001"]);
    await expect(readChannelAllowFromStore("telegram", env, "beta")).resolves.toEqual([]);

    const alpha = await upsertChannelPairingRequest({
      channel: "telegram",
      accountId: "alpha",
      id: "shared",
      env,
    });
    const beta = await upsertChannelPairingRequest({
      channel: "telegram",
      accountId: "beta",
      id: "shared",
      env,
    });
    expect(beta.code).not.toBe(alpha.code);
    expect(
      requireFirstPairingRequest(await listChannelPairingRequests("telegram", env, "alpha")).code,
    ).toBe(alpha.code);
    expect(
      requireFirstPairingRequest(await listChannelPairingRequests("telegram", env, "beta")).code,
    ).toBe(beta.code);

    await expect(
      approveChannelPairingCode({ channel: "telegram", code: alpha.code, env }),
    ).resolves.toMatchObject({ id: "shared" });
    await expect(readChannelAllowFromStore("telegram", env, "alpha")).resolves.toEqual([
      "1001",
      "shared",
    ]);
    await expect(readChannelAllowFromStore("telegram", env, "beta")).resolves.toEqual([]);

    await expect(
      removeChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "alpha",
        entry: "1001",
        env,
      }),
    ).resolves.toEqual({ changed: true, allowFrom: ["shared"] });
  });

  it("reads current SQLite entries without a process-local file cache", async () => {
    const env = pairingEnv;
    writeAllowFromFixture({ env, channel: "telegram", accountId: "yy", allowFrom: ["1001"] });
    await expect(readChannelAllowFromStore("telegram", env, "yy")).resolves.toEqual(["1001"]);
    expect(readChannelAllowFromStoreSync("telegram", env, "yy")).toEqual(["1001"]);

    writeAllowFromFixture({ env, channel: "telegram", accountId: "yy", allowFrom: ["10022"] });
    await expect(readChannelAllowFromStore("telegram", env, "yy")).resolves.toEqual(["10022"]);
    const sql = observeHostDataSql();
    try {
      expect(readChannelAllowFromStoreSync("telegram", env, "yy")).toEqual(["10022"]);
      expect(sql.queries.filter((query) => query.includes("channel_pairing_requests"))).toEqual([]);
    } finally {
      sql.restore();
    }
  });
});
