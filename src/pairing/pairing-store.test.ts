import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../config/paths.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  addChannelAllowFromStoreEntry,
  approveChannelPairingCode,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  readLegacyChannelAllowFromStore,
  readLegacyChannelAllowFromStoreSync,
  readChannelAllowFromStoreSync,
  removeChannelAllowFromStoreEntry,
  upsertChannelPairingRequest,
  type PairingRequest,
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
  const oauthDir = resolveOAuthDir(process.env, params.stateDir);
  await fs.mkdir(oauthDir, { recursive: true });
  const suffix = params.accountId ? `-${params.accountId}` : "";
  await writeJsonFixture(path.join(oauthDir, `${params.channel}${suffix}-allowFrom.json`), {
    version: 1,
    allowFrom: params.allowFrom,
  });
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

      const accountScoped = await readChannelAllowFromStore("telegram", process.env, "yy");
      const channelScoped = await readLegacyChannelAllowFromStore("telegram");
      expect(accountScoped).toContain("12345");
      expect(channelScoped).not.toContain("12345");
    });
  });

  it("approves pairing codes into account-scoped allowFrom via pairing metadata", async () => {
    await withTempStateDir(async () => {
      const created = await upsertChannelPairingRequest({
        channel: "telegram",
        accountId: "yy",
        id: "12345",
      });
      expect(created.created).toBe(true);

      const approved = await approveChannelPairingCode({
        channel: "telegram",
        code: created.code,
      });
      expect(approved?.id).toBe("12345");

      const accountScoped = await readChannelAllowFromStore("telegram", process.env, "yy");
      const channelScoped = await readLegacyChannelAllowFromStore("telegram");
      expect(accountScoped).toContain("12345");
      expect(channelScoped).not.toContain("12345");
    });
  });

  it("filters approvals by account id and ignores blank approval codes", async () => {
    await withTempStateDir(async () => {
      const created = await upsertChannelPairingRequest({
        channel: "telegram",
        accountId: "yy",
        id: "12345",
      });
      expect(created.created).toBe(true);

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
      await writeAllowFromFixture({
        stateDir,
        channel: "telegram",
        allowFrom: ["1001", "*", "1002", "1001"],
      });
      await writeAllowFromFixture({
        stateDir,
        channel: "telegram",
        accountId: "yy",
        allowFrom: ["1003"],
      });

      const asyncScoped = await readChannelAllowFromStore("telegram", process.env, "yy");
      const syncScoped = readChannelAllowFromStoreSync("telegram", process.env, "yy");
      expect(asyncScoped).toEqual(["1003"]);
      expect(syncScoped).toEqual(["1003"]);
    });
  });

  it("does not fall back to legacy allowFrom when scoped file exists but is empty", async () => {
    await withTempStateDir(async (stateDir) => {
      await writeAllowFromFixture({
        stateDir,
        channel: "telegram",
        allowFrom: ["1001"],
      });
      await writeAllowFromFixture({
        stateDir,
        channel: "telegram",
        accountId: "yy",
        allowFrom: [],
      });

      const asyncScoped = await readChannelAllowFromStore("telegram", process.env, "yy");
      const syncScoped = readChannelAllowFromStoreSync("telegram", process.env, "yy");
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

  it("reads legacy channel-scoped allowFrom for default account", async () => {
    await withTempStateDir(async (stateDir) => {
      await writeAllowFromFixture({ stateDir, channel: "telegram", allowFrom: ["1001"] });
      await writeAllowFromFixture({
        stateDir,
        channel: "telegram",
        accountId: "default",
        allowFrom: ["1002"],
      });

      const scoped = await readChannelAllowFromStore("telegram", process.env, DEFAULT_ACCOUNT_ID);
      expect(scoped).toEqual(["1002", "1001"]);
    });
  });

  describe("reminder logic", () => {
    it("increments reminder count on repeated messages within 5 minutes", async () => {
      await withTempStateDir(async () => {
        const first = await upsertChannelPairingRequest({
          channel: "telegram",
          id: "user1",
          accountId: DEFAULT_ACCOUNT_ID,
        });
        expect(first.created).toBe(true);
        expect(first.shouldRemind).toBe(true);

        const second = await upsertChannelPairingRequest({
          channel: "telegram",
          id: "user1",
          accountId: DEFAULT_ACCOUNT_ID,
        });
        expect(second.created).toBe(false);
        expect(second.shouldRemind).toBe(true);

        const third = await upsertChannelPairingRequest({
          channel: "telegram",
          id: "user1",
          accountId: DEFAULT_ACCOUNT_ID,
        });
        expect(third.created).toBe(false);
        expect(third.shouldRemind).toBe(true);
      });
    });

    it("resets reminder count after 5-minute window", async () => {
      await withTempStateDir(async (stateDir) => {
        // Create initial request
        const first = await upsertChannelPairingRequest({
          channel: "telegram",
          id: "user1",
          accountId: DEFAULT_ACCOUNT_ID,
        });
        expect(first.shouldRemind).toBe(true);

        // Manually set lastReminderAt to be > 5 minutes ago
        const filePath = resolvePairingFilePath(stateDir, "telegram");
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as { requests: PairingRequest[] };
        const oldTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
        parsed.requests[0].lastReminderAt = oldTime;
        parsed.requests[0].reminderCount = 5;
        await fs.writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

        // After window expires, count should reset and shouldRemind should be true
        const after = await upsertChannelPairingRequest({
          channel: "telegram",
          id: "user1",
          accountId: DEFAULT_ACCOUNT_ID,
        });
        expect(after.shouldRemind).toBe(true);
      });
    });

    it("stops reminding after 5 reminders within the window", async () => {
      await withTempStateDir(async () => {
        // Create request
        await upsertChannelPairingRequest({
          channel: "telegram",
          id: "user1",
          accountId: DEFAULT_ACCOUNT_ID,
        });

        // Call 4 more times (total 5 reminders)
        for (let i = 0; i < 4; i++) {
          const result = await upsertChannelPairingRequest({
            channel: "telegram",
            id: "user1",
            accountId: DEFAULT_ACCOUNT_ID,
          });
          expect(result.shouldRemind).toBe(true);
        }

        // 6th call should not remind
        const sixth = await upsertChannelPairingRequest({
          channel: "telegram",
          id: "user1",
          accountId: DEFAULT_ACCOUNT_ID,
        });
        expect(sixth.shouldRemind).toBe(false);
      });
    });

    it("handles backwards compatibility with requests without reminder fields", async () => {
      await withTempStateDir(async (stateDir) => {
        // Create a request without reminder fields (simulating old data)
        const filePath = resolvePairingFilePath(stateDir, "telegram");
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const oldRequest = {
          id: "user1",
          code: "OLDCODE",
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          meta: { accountId: "default" }, // Required for matching
          // No reminderCount or lastReminderAt
        };
        await fs.writeFile(
          filePath,
          `${JSON.stringify({ version: 1, requests: [oldRequest] }, null, 2)}\n`,
          "utf8",
        );

        // Should still work and shouldRemind should be true (count starts at 0, < 5)
        const result = await upsertChannelPairingRequest({
          channel: "telegram",
          id: "user1",
          accountId: DEFAULT_ACCOUNT_ID,
        });
        expect(result.shouldRemind).toBe(true);
        expect(result.code).toBe("OLDCODE");
      });
    });
  });
});
