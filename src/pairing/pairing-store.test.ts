import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../config/paths.js";
import { captureEnv } from "../test-utils/env.js";
import {
  addChannelAllowFromStoreEntry,
  approveChannelPairingCode,
  listChannelPairingRequests,
  readChannelAllowFromStore,
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

async function withTempStateDir<T>(fn: (stateDir: string) => Promise<T>) {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  await fs.mkdir(dir, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    envSnapshot.restore();
  }
}

describe("pairing store", () => {
  it("reuses pending code and reports created=false", async () => {
    await withTempStateDir(async () => {
      const first = await upsertChannelPairingRequest({
        channel: "discord",
        id: "u1",
      });
      const second = await upsertChannelPairingRequest({
        channel: "discord",
        id: "u1",
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
      });
      expect(created.created).toBe(true);

      const oauthDir = resolveOAuthDir(process.env, stateDir);
      const filePath = path.join(oauthDir, "signal-pairing.json");
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
      await fs.writeFile(
        filePath,
        `${JSON.stringify({ version: 1, requests }, null, 2)}\n`,
        "utf8",
      );

      const list = await listChannelPairingRequests("signal");
      expect(list).toHaveLength(0);

      const next = await upsertChannelPairingRequest({
        channel: "signal",
        id: "+15550001111",
      });
      expect(next.created).toBe(true);
    });
  });

  it("regenerates when a generated code collides", async () => {
    await withTempStateDir(async () => {
      const spy = vi.spyOn(crypto, "randomInt");
      try {
        spy.mockReturnValue(0);
        const first = await upsertChannelPairingRequest({
          channel: "telegram",
          id: "123",
        });
        expect(first.code).toBe("AAAAAAAA");

        const sequence = Array(8).fill(0).concat(Array(8).fill(1));
        let idx = 0;
        spy.mockImplementation(() => sequence[idx++] ?? 1);
        const second = await upsertChannelPairingRequest({
          channel: "telegram",
          id: "456",
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
        });
        expect(created.created).toBe(true);
      }

      const blocked = await upsertChannelPairingRequest({
        channel: "whatsapp",
        id: "+15550000004",
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

  it("isolates allowFrom store by accountId", async () => {
    await withTempStateDir(async () => {
      // Add entry to account "yy"
      await addChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "yy",
        entry: "user1",
      });

      // Account "yy" should have the entry
      const yyList = await readChannelAllowFromStore("telegram", "yy");
      expect(yyList).toContain("user1");

      // Account "main" should NOT have the entry
      const mainList = await readChannelAllowFromStore("telegram", "main");
      expect(mainList).toHaveLength(0);

      // No accountId (legacy) should NOT have the entry
      const defaultList = await readChannelAllowFromStore("telegram");
      expect(defaultList).toHaveLength(0);
    });
  });

  it("isolates pairing requests by accountId", async () => {
    await withTempStateDir(async () => {
      const yyResult = await upsertChannelPairingRequest({
        channel: "telegram",
        accountId: "yy",
        id: "user1",
      });
      expect(yyResult.created).toBe(true);

      // "main" account should have no requests
      const mainRequests = await listChannelPairingRequests("telegram", "main");
      expect(mainRequests).toHaveLength(0);

      // "yy" account should have the request
      const yyRequests = await listChannelPairingRequests("telegram", "yy");
      expect(yyRequests).toHaveLength(1);
      expect(yyRequests[0]?.id).toBe("user1");
    });
  });

  it("approveChannelPairingCode with accountId only affects that account", async () => {
    await withTempStateDir(async () => {
      const { code } = await upsertChannelPairingRequest({
        channel: "telegram",
        accountId: "yy",
        id: "user1",
      });

      // Approve on "yy"
      const approved = await approveChannelPairingCode({
        channel: "telegram",
        accountId: "yy",
        code,
      });
      expect(approved).not.toBeNull();
      expect(approved?.id).toBe("user1");

      // "yy" allowFrom should have user1
      const yyAllow = await readChannelAllowFromStore("telegram", "yy");
      expect(yyAllow).toContain("user1");

      // "main" allowFrom should be empty
      const mainAllow = await readChannelAllowFromStore("telegram", "main");
      expect(mainAllow).toHaveLength(0);
    });
  });

  it("migrates legacy allowFrom entries when reading with accountId (before account file exists)", async () => {
    await withTempStateDir(async (stateDir) => {
      // Simulate existing legacy file (without accountId)
      const oauthDir = resolveOAuthDir(process.env, stateDir);
      await fs.mkdir(oauthDir, { recursive: true });
      const legacyPath = path.join(oauthDir, "telegram-allowFrom.json");
      await fs.writeFile(
        legacyPath,
        JSON.stringify({ version: 1, allowFrom: ["legacy_user1", "legacy_user2"] }),
        "utf8",
      );

      // Reading with accountId (before account-specific file exists) should return legacy entries
      const mainList = await readChannelAllowFromStore("telegram", "main");
      expect(mainList).toContain("legacy_user1");
      expect(mainList).toContain("legacy_user2");

      // Add a new entry to account-specific store (creates the account file)
      await addChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "main",
        entry: "new_user",
      });

      // After account-specific file exists, only account entries are returned
      // (legacy file is no longer consulted, so removals work correctly)
      const accountList = await readChannelAllowFromStore("telegram", "main");
      expect(accountList).toContain("new_user");
      expect(accountList).toHaveLength(1);
      expect(accountList).not.toContain("legacy_user1");

      // Legacy file without accountId should still work independently
      const legacyList = await readChannelAllowFromStore("telegram");
      expect(legacyList).toContain("legacy_user1");
      expect(legacyList).toContain("legacy_user2");
      expect(legacyList).not.toContain("new_user");
    });
  });
});
