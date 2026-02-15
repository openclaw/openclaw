import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../config/paths.js";
import {
  approveChannelPairingCode,
  listChannelPairingRequests,
  resetAllPairingRateLimits,
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
  const previous = process.env.OPENCLAW_STATE_DIR;
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  await fs.mkdir(dir, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
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
});

// Aether AI Agent — OC-100 rate limiting tests
describe("pairing code rate limiting (OC-100)", () => {
  beforeAll(() => {
    resetAllPairingRateLimits();
  });

  afterAll(() => {
    resetAllPairingRateLimits();
  });

  it("allows pairing attempts below the rate limit threshold", async () => {
    resetAllPairingRateLimits();
    await withTempStateDir(async () => {
      await upsertChannelPairingRequest({ channel: "discord", id: "rate-test-1" });

      // 9 wrong attempts should all return null without throwing
      for (let i = 0; i < 9; i++) {
        const result = await approveChannelPairingCode({
          channel: "discord",
          code: "WRONGCODE",
        });
        expect(result).toBeNull();
      }
    });
  });

  it("throws after exceeding max failed attempts", async () => {
    resetAllPairingRateLimits();
    await withTempStateDir(async () => {
      await upsertChannelPairingRequest({ channel: "discord", id: "rate-test-2" });

      // Exhaust the 10 allowed attempts
      for (let i = 0; i < 10; i++) {
        await approveChannelPairingCode({ channel: "discord", code: "BADCODE00" });
      }

      // 11th attempt should throw
      await expect(
        approveChannelPairingCode({ channel: "discord", code: "BADCODE00" }),
      ).rejects.toThrow("Too many failed pairing attempts");
    });
  });

  it("resets rate limit after successful pairing", async () => {
    resetAllPairingRateLimits();
    await withTempStateDir(async () => {
      const { code } = await upsertChannelPairingRequest({
        channel: "telegram",
        id: "rate-test-3",
      });

      // Accumulate 9 failures
      for (let i = 0; i < 9; i++) {
        await approveChannelPairingCode({ channel: "telegram", code: "WRONGCODE" });
      }

      // Successful approval resets counter
      const result = await approveChannelPairingCode({ channel: "telegram", code });
      expect(result).not.toBeNull();
      expect(result?.id).toBe("rate-test-3");

      // Should be able to attempt again without rate limit
      const afterReset = await approveChannelPairingCode({
        channel: "telegram",
        code: "WRONGCODE",
      });
      expect(afterReset).toBeNull(); // null, not throw
    });
  });

  it("rate limits are per-channel", async () => {
    resetAllPairingRateLimits();
    await withTempStateDir(async () => {
      await upsertChannelPairingRequest({ channel: "discord", id: "chan-a" });
      await upsertChannelPairingRequest({ channel: "signal", id: "chan-b" });

      // Exhaust discord rate limit
      for (let i = 0; i < 10; i++) {
        await approveChannelPairingCode({ channel: "discord", code: "WRONGCODE" });
      }

      // Discord should be locked out
      await expect(
        approveChannelPairingCode({ channel: "discord", code: "WRONGCODE" }),
      ).rejects.toThrow("Too many failed pairing attempts");

      // Signal should still work fine
      const signalResult = await approveChannelPairingCode({
        channel: "signal",
        code: "WRONGCODE",
      });
      expect(signalResult).toBeNull();
    });
  });
});
