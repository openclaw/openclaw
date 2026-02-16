import crypto from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../config/paths.js";
import {
  addChannelAllowFromStoreEntry,
  approveChannelPairingCode,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "./pairing-store.js";

async function withTempStateDir<T>(fn: (stateDir: string) => Promise<T>) {
  const previous = process.env.OPENCLAW_STATE_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pairing-"));
  process.env.OPENCLAW_STATE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeAllowFromFile(params: {
  stateDir: string;
  channel: string;
  allowFrom: string[];
}) {
  const oauthDir = resolveOAuthDir(process.env, params.stateDir);
  const filePath = path.join(oauthDir, `${params.channel}-allowFrom.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ version: 1, allowFrom: params.allowFrom }, null, 2)}\n`,
    "utf8",
  );
  return filePath;
}

function countReadCallsForPath(
  spy: ReturnType<typeof vi.spyOn<typeof fsNative.promises, "readFile">>,
  filePath: string,
): number {
  const expected = path.resolve(filePath);
  return spy.mock.calls.filter(([inputPath]) => {
    if (typeof inputPath !== "string") {
      return false;
    }
    return path.resolve(inputPath) === expected;
  }).length;
}

async function withAllowlistCacheEnv<T>(
  env: Partial<
    Record<
      "OPENCLAW_DISABLE_PAIRING_ALLOWLIST_CACHE" | "OPENCLAW_PAIRING_ALLOWLIST_CACHE_TTL_MS",
      string
    >
  >,
  fn: () => Promise<T>,
): Promise<T> {
  const prevDisable = process.env.OPENCLAW_DISABLE_PAIRING_ALLOWLIST_CACHE;
  const prevTtl = process.env.OPENCLAW_PAIRING_ALLOWLIST_CACHE_TTL_MS;
  if (env.OPENCLAW_DISABLE_PAIRING_ALLOWLIST_CACHE === undefined) {
    delete process.env.OPENCLAW_DISABLE_PAIRING_ALLOWLIST_CACHE;
  } else {
    process.env.OPENCLAW_DISABLE_PAIRING_ALLOWLIST_CACHE =
      env.OPENCLAW_DISABLE_PAIRING_ALLOWLIST_CACHE;
  }
  if (env.OPENCLAW_PAIRING_ALLOWLIST_CACHE_TTL_MS === undefined) {
    delete process.env.OPENCLAW_PAIRING_ALLOWLIST_CACHE_TTL_MS;
  } else {
    process.env.OPENCLAW_PAIRING_ALLOWLIST_CACHE_TTL_MS =
      env.OPENCLAW_PAIRING_ALLOWLIST_CACHE_TTL_MS;
  }
  try {
    return await fn();
  } finally {
    if (prevDisable === undefined) {
      delete process.env.OPENCLAW_DISABLE_PAIRING_ALLOWLIST_CACHE;
    } else {
      process.env.OPENCLAW_DISABLE_PAIRING_ALLOWLIST_CACHE = prevDisable;
    }
    if (prevTtl === undefined) {
      delete process.env.OPENCLAW_PAIRING_ALLOWLIST_CACHE_TTL_MS;
    } else {
      process.env.OPENCLAW_PAIRING_ALLOWLIST_CACHE_TTL_MS = prevTtl;
    }
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

  it("caches allowFrom reads and invalidates on allowFrom writes", async () => {
    await withAllowlistCacheEnv({}, async () => {
      await withTempStateDir(async (stateDir) => {
        const filePath = await writeAllowFromFile({
          stateDir,
          channel: "discord",
          allowFrom: ["u1"],
        });
        const readSpy = vi.spyOn(fsNative.promises, "readFile");
        try {
          const first = await readChannelAllowFromStore("discord");
          const second = await readChannelAllowFromStore("discord");
          expect(first).toEqual(["u1"]);
          expect(second).toEqual(["u1"]);

          await addChannelAllowFromStoreEntry({
            channel: "discord",
            entry: "u2",
          });
          const third = await readChannelAllowFromStore("discord");
          expect(third).toEqual(["u1", "u2"]);

          expect(countReadCallsForPath(readSpy, filePath)).toBe(3);
        } finally {
          readSpy.mockRestore();
        }
      });
    });
  });

  it("invalidates allowFrom cache after pairing approval", async () => {
    await withAllowlistCacheEnv({}, async () => {
      await withTempStateDir(async (stateDir) => {
        const filePath = await writeAllowFromFile({
          stateDir,
          channel: "telegram",
          allowFrom: [],
        });
        const req = await upsertChannelPairingRequest({
          channel: "telegram",
          id: "123",
        });
        expect(req.created).toBe(true);

        const readSpy = vi.spyOn(fsNative.promises, "readFile");
        try {
          await readChannelAllowFromStore("telegram");
          await readChannelAllowFromStore("telegram");

          const approved = await approveChannelPairingCode({
            channel: "telegram",
            code: req.code,
          });
          expect(approved?.id).toBe("123");

          const allowFrom = await readChannelAllowFromStore("telegram");
          expect(allowFrom).toEqual(["123"]);

          expect(countReadCallsForPath(readSpy, filePath)).toBe(3);
        } finally {
          readSpy.mockRestore();
        }
      });
    });
  });

  it("disables allowFrom cache when OPENCLAW_DISABLE_PAIRING_ALLOWLIST_CACHE is set", async () => {
    await withAllowlistCacheEnv({ OPENCLAW_DISABLE_PAIRING_ALLOWLIST_CACHE: "1" }, async () => {
      await withTempStateDir(async (stateDir) => {
        const filePath = await writeAllowFromFile({
          stateDir,
          channel: "signal",
          allowFrom: ["+1000"],
        });
        const readSpy = vi.spyOn(fsNative.promises, "readFile");
        try {
          await readChannelAllowFromStore("signal");
          await readChannelAllowFromStore("signal");
          expect(countReadCallsForPath(readSpy, filePath)).toBe(2);
        } finally {
          readSpy.mockRestore();
        }
      });
    });
  });

  it("expires allowFrom cache entries using OPENCLAW_PAIRING_ALLOWLIST_CACHE_TTL_MS", async () => {
    await withAllowlistCacheEnv({ OPENCLAW_PAIRING_ALLOWLIST_CACHE_TTL_MS: "5" }, async () => {
      await withTempStateDir(async (stateDir) => {
        const filePath = await writeAllowFromFile({
          stateDir,
          channel: "whatsapp",
          allowFrom: ["+15550001111"],
        });
        const readSpy = vi.spyOn(fsNative.promises, "readFile");
        try {
          await readChannelAllowFromStore("whatsapp");
          await new Promise((resolve) => setTimeout(resolve, 20));
          await readChannelAllowFromStore("whatsapp");
          expect(countReadCallsForPath(readSpy, filePath)).toBe(2);
        } finally {
          readSpy.mockRestore();
        }
      });
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
});
