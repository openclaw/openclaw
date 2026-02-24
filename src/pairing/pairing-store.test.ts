import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../config/paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  addChannelAllowFromStoreEntry,
  approveChannelPairingCode,
  listChannelPairingRequests,
  readChannelAllowFromStore,
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

async function withTempStateDir<T>(fn: (stateDir: string) => Promise<T>) {
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  await fs.mkdir(dir, { recursive: true });
  return await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => await fn(dir));
}

async function writeJsonFixture(filePath: string, value: unknown) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolvePairingFilePath(stateDir: string, channel: string) {
  return path.join(resolveOAuthDir(process.env, stateDir), `${channel}-pairing.json`);
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

  it("stores allowFrom entries per account when accountId is provided", async () => {
    await withTempStateDir(async () => {
      await addChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "yy",
        entry: "12345",
      });

      const accountScoped = await readChannelAllowFromStore("telegram", process.env, "yy");
      const channelScoped = await readChannelAllowFromStore("telegram");
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
      const channelScoped = await readChannelAllowFromStore("telegram");
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

  it("reads sync allowFrom with scoped + legacy dedupe and wildcard filtering", async () => {
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
      const channelScoped = readChannelAllowFromStoreSync("telegram");
      expect(scoped).toEqual(["1002", "1001"]);
      expect(channelScoped).toEqual(["1001", "1001"]);
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

      const scoped = await readChannelAllowFromStore("telegram", process.env, "default");
      expect(scoped).toEqual(["1002", "1001"]);
    });
  });
});
