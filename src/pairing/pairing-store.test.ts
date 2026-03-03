import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../config/paths.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  addChannelAllowFromStoreEntry,
  clearPairingAllowFromReadCacheForTest,
  approveChannelPairingCode,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  readLegacyChannelAllowFromStore,
  readLegacyChannelAllowFromStoreSync,
  readChannelAllowFromStoreSync,
  removeChannelAllowFromStoreEntry,
  upsertChannelPairingRequest,
} from "./pairing-store.js";

let fixtureRoot = "";
let caseId = 0;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pairing-"));
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

beforeEach(() => {
  clearPairingAllowFromReadCacheForTest();
});

async function withTempStateDir<T>(fn: (stateDir: string) => Promise<T>) {
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  await fs.mkdir(dir, { recursive: true });
  return await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => await fn(dir));
}

async function writeJsonFixture(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolvePairingFilePath(stateDir: string, channel: string) {
  return path.join(resolveOAuthDir(process.env, stateDir), `${channel}-pairing.json`);
}

function resolveAllowFromFilePath(stateDir: string, channel: string, accountId?: string) {
  const suffix = accountId ? `-${accountId}` : "";
  return path.join(resolveOAuthDir(process.env, stateDir), `${channel}${suffix}-allowFrom.json`);
}

async function writeAllowFromFixture(params: {
  stateDir: string;
  channel: string;
  allowFrom: string[];
  accountId?: string;
}) {
  await writeJsonFixture(
    resolveAllowFromFilePath(params.stateDir, params.channel, params.accountId),
    {
      version: 1,
      allowFrom: params.allowFrom,
    },
  );
}

async function createTelegramPairingRequest(accountId: string, id = "12345") {
  const created = await upsertChannelPairingRequest({
    channel: "telegram",
    accountId,
    id,
  });
  expect(created.created).toBe(true);
  return created;
}

async function seedTelegramAllowFromFixtures(params: {
  stateDir: string;
  scopedAccountId: string;
  scopedAllowFrom: string[];
  legacyAllowFrom?: string[];
}) {
  await writeAllowFromFixture({
    stateDir: params.stateDir,
    channel: "telegram",
    allowFrom: params.legacyAllowFrom ?? ["1001"],
  });
  await writeAllowFromFixture({
    stateDir: params.stateDir,
    channel: "telegram",
    accountId: params.scopedAccountId,
    allowFrom: params.scopedAllowFrom,
  });
}

async function assertAllowFromCacheInvalidation(params: {
  stateDir: string;
  readAllowFrom: () => Promise<string[]>;
  readSpy: {
    mockRestore: () => void;
  };
}) {
  const first = await params.readAllowFrom();
  const second = await params.readAllowFrom();
  expect(first).toEqual(["1001"]);
  expect(second).toEqual(["1001"]);
  expect(params.readSpy).toHaveBeenCalledTimes(1);

  await writeAllowFromFixture({
    stateDir: params.stateDir,
    channel: "telegram",
    accountId: "yy",
    allowFrom: ["10022"],
  });
  const third = await params.readAllowFrom();
  expect(third).toEqual(["10022"]);
  expect(params.readSpy).toHaveBeenCalledTimes(2);
}

async function expectAccountScopedEntryIsolated(entry: string, accountId = "yy") {
  const accountScoped = await readChannelAllowFromStore("telegram", process.env, accountId);
  const channelScoped = await readLegacyChannelAllowFromStore("telegram");
  expect(accountScoped).toContain(entry);
  expect(channelScoped).not.toContain(entry);
}

async function readScopedAllowFromPair(accountId: string) {
  const asyncScoped = await readChannelAllowFromStore("telegram", process.env, accountId);
  const syncScoped = readChannelAllowFromStoreSync("telegram", process.env, accountId);
  return { asyncScoped, syncScoped };
}

async function withAllowFromCacheReadSpy(params: {
  stateDir: string;
  createReadSpy: () => {
    mockRestore: () => void;
  };
  readAllowFrom: () => Promise<string[]>;
}) {
  await writeAllowFromFixture({
    stateDir: params.stateDir,
    channel: "telegram",
    accountId: "yy",
    allowFrom: ["1001"],
  });
  const readSpy = params.createReadSpy();
  await assertAllowFromCacheInvalidation({
    stateDir: params.stateDir,
    readAllowFrom: params.readAllowFrom,
    readSpy,
  });
  readSpy.mockRestore();
}

describe("pairing store", () => {
  it("reuses pending code and reports created=false", async () => {
    await withTempStateDir(async () => {
      const first = await upsertChannelPairingRequest({
        channel: "discord",
        id: "u1",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      const second = await upsertChannelPairingRequest({
        channel: "discord",
        id: "u1",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.code).toBe(first.code);

      const list = await listChannelPairingRequests("discord");
      expect(list).toHaveLength(1);
      expect(list[0]?.code).toBe(first.code);
    });
  });

  it("expires pending requests after TTL", async () => {
    await withTempStateDir(async (stateDir) => {
      const created = await upsertChannelPairingRequest({
        channel: "signal",
        id: "+15550001111",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      expect(created.created).toBe(true);

      const filePath = resolvePairingFilePath(stateDir, "signal");
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as {
        requests?: Array<Record<string, unknown>>;
      };
      const expiredAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const requests = (parsed.requests ?? []).map((entry) => ({
        ...entry,
        createdAt: expiredAt,
        lastSeenAt: expiredAt,
      }));
      await writeJsonFixture(filePath, { version: 1, requests });

      const list = await listChannelPairingRequests("signal");
      expect(list).toHaveLength(0);

      const next = await upsertChannelPairingRequest({
        channel: "signal",
        id: "+15550001111",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      expect(next.created).toBe(true);
    });
  });

  it("regenerates when a generated code collides", async () => {
    await withTempStateDir(async () => {
      const spy = vi.spyOn(crypto, "randomInt") as unknown as {
        mockReturnValue: (value: number) => void;
        mockImplementation: (fn: () => number) => void;
        mockRestore: () => void;
      };
      try {
        spy.mockReturnValue(0);
        const first = await upsertChannelPairingRequest({
          channel: "telegram",
          id: "123",
          accountId: DEFAULT_ACCOUNT_ID,
        });
        expect(first.code).toBe("AAAAAAAA");

        const sequence = Array(8).fill(0).concat(Array(8).fill(1));
        let idx = 0;
        spy.mockImplementation(() => sequence[idx++] ?? 1);
        const second = await upsertChannelPairingRequest({
          channel: "telegram",
          id: "456",
          accountId: DEFAULT_ACCOUNT_ID,
        });
        expect(second.code).toBe("BBBBBBBB");
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("caps pending requests at the default limit", async () => {
    await withTempStateDir(async () => {
      const ids = ["+15550000001", "+15550000002", "+15550000003"];
      for (const id of ids) {
        const created = await upsertChannelPairingRequest({
          channel: "whatsapp",
          id,
          accountId: DEFAULT_ACCOUNT_ID,
        });
        expect(created.created).toBe(true);
      }

      const blocked = await upsertChannelPairingRequest({
        channel: "whatsapp",
        id: "+15550000004",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      expect(blocked.created).toBe(false);

      const list = await listChannelPairingRequests("whatsapp");
      const listIds = list.map((entry) => entry.id);
      expect(listIds).toHaveLength(3);
      expect(listIds).toContain("+15550000001");
      expect(listIds).toContain("+15550000002");
      expect(listIds).toContain("+15550000003");
      expect(listIds).not.toContain("+15550000004");
    });
  });

  it("stores allowFrom entries per account when accountId is provided", async () => {
    await withTempStateDir(async () => {
      await addChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "yy",
        entry: "12345",
      });

      await expectAccountScopedEntryIsolated("12345");
    });
  });

  it("approves pairing codes into account-scoped allowFrom via pairing metadata", async () => {
    await withTempStateDir(async () => {
      const created = await createTelegramPairingRequest("yy");

      const approved = await approveChannelPairingCode({
        channel: "telegram",
        code: created.code,
      });
      expect(approved?.id).toBe("12345");

      await expectAccountScopedEntryIsolated("12345");
    });
  });

  it("filters approvals by account id and ignores blank approval codes", async () => {
    await withTempStateDir(async () => {
      const created = await createTelegramPairingRequest("yy");

      const blank = await approveChannelPairingCode({
        channel: "telegram",
        code: "   ",
      });
      expect(blank).toBeNull();

      const mismatched = await approveChannelPairingCode({
        channel: "telegram",
        code: created.code,
        accountId: "zz",
      });
      expect(mismatched).toBeNull();

      const pending = await listChannelPairingRequests("telegram");
      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBe("12345");
    });
  });

  it("removes account-scoped allowFrom entries idempotently", async () => {
    await withTempStateDir(async () => {
      await addChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "yy",
        entry: "12345",
      });

      const removed = await removeChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "yy",
        entry: "12345",
      });
      expect(removed.changed).toBe(true);
      expect(removed.allowFrom).toEqual([]);

      const removedAgain = await removeChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "yy",
        entry: "12345",
      });
      expect(removedAgain.changed).toBe(false);
      expect(removedAgain.allowFrom).toEqual([]);
    });
  });

  it("reads sync allowFrom with account-scoped isolation and wildcard filtering", async () => {
    await withTempStateDir(async (stateDir) => {
      await writeAllowFromFixture({
        stateDir,
        channel: "telegram",
        allowFrom: ["1001", "*", " 1001 ", "  "],
      });
      await writeAllowFromFixture({
        stateDir,
        channel: "telegram",
        accountId: "yy",
        allowFrom: [" 1002 ", "1001", "1002"],
      });

      const scoped = readChannelAllowFromStoreSync("telegram", process.env, "yy");
      const channelScoped = readLegacyChannelAllowFromStoreSync("telegram");
      expect(scoped).toEqual(["1002", "1001"]);
      expect(channelScoped).toEqual(["1001"]);
    });
  });

  it("does not read legacy channel-scoped allowFrom for non-default account ids", async () => {
    await withTempStateDir(async (stateDir) => {
      await seedTelegramAllowFromFixtures({
        stateDir,
        scopedAccountId: "yy",
        scopedAllowFrom: ["1003"],
        legacyAllowFrom: ["1001", "*", "1002", "1001"],
      });

      const { asyncScoped, syncScoped } = await readScopedAllowFromPair("yy");
      expect(asyncScoped).toEqual(["1003"]);
      expect(syncScoped).toEqual(["1003"]);
    });
  });

  it("does not fall back to legacy allowFrom when scoped file exists but is empty", async () => {
    await withTempStateDir(async (stateDir) => {
      await seedTelegramAllowFromFixtures({
        stateDir,
        scopedAccountId: "yy",
        scopedAllowFrom: [],
      });

      const { asyncScoped, syncScoped } = await readScopedAllowFromPair("yy");
      expect(asyncScoped).toEqual([]);
      expect(syncScoped).toEqual([]);
    });
  });

  it("keeps async and sync reads aligned for malformed scoped allowFrom files", async () => {
    await withTempStateDir(async (stateDir) => {
      await writeAllowFromFixture({
        stateDir,
        channel: "telegram",
        allowFrom: ["1001"],
      });
      const malformedScopedPath = resolveAllowFromFilePath(stateDir, "telegram", "yy");
      await fs.mkdir(path.dirname(malformedScopedPath), { recursive: true });
      await fs.writeFile(malformedScopedPath, "{ this is not json\n", "utf8");

      const asyncScoped = await readChannelAllowFromStore("telegram", process.env, "yy");
      const syncScoped = readChannelAllowFromStoreSync("telegram", process.env, "yy");
      expect(asyncScoped).toEqual([]);
      expect(syncScoped).toEqual([]);
    });
  });

  it("does not reuse pairing requests across accounts for the same sender id", async () => {
    await withTempStateDir(async () => {
      const first = await upsertChannelPairingRequest({
        channel: "telegram",
        accountId: "alpha",
        id: "12345",
      });
      const second = await upsertChannelPairingRequest({
        channel: "telegram",
        accountId: "beta",
        id: "12345",
      });

      expect(first.created).toBe(true);
      expect(second.created).toBe(true);
      expect(second.code).not.toBe(first.code);

      const alpha = await listChannelPairingRequests("telegram", process.env, "alpha");
      const beta = await listChannelPairingRequests("telegram", process.env, "beta");
      expect(alpha).toHaveLength(1);
      expect(beta).toHaveLength(1);
      expect(alpha[0]?.code).toBe(first.code);
      expect(beta[0]?.code).toBe(second.code);
    });
  });

  it("tracks failed pairing attempts and auto-expires after threshold", async () => {
    await withTempStateDir(async () => {
      const created = await upsertChannelPairingRequest({
        channel: "telegram",
        id: "12345",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      expect(created.created).toBe(true);

      // Submit 9 wrong codes — request should still exist
      for (let i = 0; i < 9; i++) {
        const result = await approveChannelPairingCode({
          channel: "telegram",
          code: "WRONGCODE",
        });
        expect(result).toBeNull();
      }

      let pending = await listChannelPairingRequests("telegram");
      expect(pending).toHaveLength(1);
      expect(pending[0]?.failedAttempts).toBe(9);

      // 10th wrong attempt — should auto-expire the request
      const result = await approveChannelPairingCode({
        channel: "telegram",
        code: "WRONGCODE",
      });
      expect(result).toBeNull();

      pending = await listChannelPairingRequests("telegram");
      expect(pending).toHaveLength(0);
    });
  });

  it("correct code still works before brute-force threshold", async () => {
    await withTempStateDir(async () => {
      const created = await upsertChannelPairingRequest({
        channel: "telegram",
        id: "12345",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      expect(created.created).toBe(true);

      // Submit 5 wrong codes
      for (let i = 0; i < 5; i++) {
        await approveChannelPairingCode({
          channel: "telegram",
          code: "WRONGCODE",
        });
      }

      // Correct code still works
      const approved = await approveChannelPairingCode({
        channel: "telegram",
        code: created.code,
      });
      expect(approved?.id).toBe("12345");
    });
  });

  it("does not increment account-scoped requests for unscoped wrong attempts", async () => {
    await withTempStateDir(async () => {
      await upsertChannelPairingRequest({
        channel: "telegram",
        id: "alice-1",
        accountId: "alice",
      });
      await upsertChannelPairingRequest({
        channel: "telegram",
        id: "bob-1",
        accountId: "bob",
      });

      // Wrong code with no accountId should NOT burn account-scoped requests.
      for (let i = 0; i < 12; i++) {
        await approveChannelPairingCode({
          channel: "telegram",
          code: "WRONGCODE",
        });
      }

      const pending = await listChannelPairingRequests("telegram");
      expect(pending).toHaveLength(2);
      const byId = new Map(pending.map((p) => [p.id, p]));
      expect(byId.get("alice-1")?.failedAttempts ?? 0).toBe(0);
      expect(byId.get("bob-1")?.failedAttempts ?? 0).toBe(0);
    });
  });

  it("reads legacy channel-scoped allowFrom for default account", async () => {
    await withTempStateDir(async (stateDir) => {
      await seedTelegramAllowFromFixtures({
        stateDir,
        scopedAccountId: "default",
        scopedAllowFrom: ["1002"],
      });

      const scoped = await readChannelAllowFromStore("telegram", process.env, DEFAULT_ACCOUNT_ID);
      expect(scoped).toEqual(["1002", "1001"]);
    });
  });

  it("uses default-account allowFrom when account id is omitted", async () => {
    await withTempStateDir(async (stateDir) => {
      await seedTelegramAllowFromFixtures({
        stateDir,
        scopedAccountId: DEFAULT_ACCOUNT_ID,
        scopedAllowFrom: ["1002"],
      });

      const asyncScoped = await readChannelAllowFromStore("telegram", process.env);
      const syncScoped = readChannelAllowFromStoreSync("telegram", process.env);
      expect(asyncScoped).toEqual(["1002", "1001"]);
      expect(syncScoped).toEqual(["1002", "1001"]);
    });
  });

  it("reuses cached async allowFrom reads and invalidates on file updates", async () => {
    await withTempStateDir(async (stateDir) => {
      await withAllowFromCacheReadSpy({
        stateDir,
        createReadSpy: () => vi.spyOn(fs, "readFile"),
        readAllowFrom: () => readChannelAllowFromStore("telegram", process.env, "yy"),
      });
    });
  });

  it("reuses cached sync allowFrom reads and invalidates on file updates", async () => {
    await withTempStateDir(async (stateDir) => {
      await withAllowFromCacheReadSpy({
        stateDir,
        createReadSpy: () => vi.spyOn(fsSync, "readFileSync"),
        readAllowFrom: async () => readChannelAllowFromStoreSync("telegram", process.env, "yy"),
      });
    });
  });
});
