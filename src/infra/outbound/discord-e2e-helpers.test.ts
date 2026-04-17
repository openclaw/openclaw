import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @buape/carbon's RequestClient so REST calls resolve without network I/O.
// The mock is hoisted before importing the helpers so their getRestClient()
// cache closes over the mocked constructor.
const restHandlers = vi.hoisted(() => {
  const get = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => []);
  const post = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    id: "m-1",
    channel_id: "c",
  }));
  const patch = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({}));
  const put = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({}));
  const del = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({}));
  return { get, post, patch, put, delete: del };
});

vi.mock("@buape/carbon", () => {
  class RequestClient {
    // We accept the token purely to match the real constructor signature.
    token: string;
    constructor(token: string) {
      this.token = token;
    }
    get(...args: unknown[]) {
      return restHandlers.get(...args);
    }
    post(...args: unknown[]) {
      return restHandlers.post(...args);
    }
    patch(...args: unknown[]) {
      return restHandlers.patch(...args);
    }
    put(...args: unknown[]) {
      return restHandlers.put(...args);
    }
    delete(...args: unknown[]) {
      return restHandlers.delete(...args);
    }
  }
  return { RequestClient };
});

import {
  FORBIDDEN_CHATTER_DEFAULT,
  LEAK_PATTERNS_DEFAULT,
  assertAuthorIdentity,
  assertContentScrubbed,
  assertNoForbiddenChatter,
  assertNoLeaksInThread,
  isDiscordE2EEnabled,
  resolveDiscordE2EEnv,
  withDiscordRetry,
} from "./discord-e2e-helpers.js";

const ORIGINAL_ENV = { ...process.env };

function clearLiveEnv() {
  delete process.env.OPENCLAW_LIVE_DISCORD;
  delete process.env.OPENCLAW_LIVE_DISCORD_BOT_TOKEN;
  delete process.env.OPENCLAW_LIVE_DISCORD_GUILD_ID;
  delete process.env.OPENCLAW_LIVE_DISCORD_PARENT_CHANNEL_ID;
  delete process.env.OPENCLAW_LIVE_DISCORD_ACCOUNT_ID;
  delete process.env.OPENCLAW_LIVE_DISCORD_SECONDARY_CHANNEL_ID;
}

beforeEach(() => {
  clearLiveEnv();
  restHandlers.get.mockReset();
  restHandlers.post.mockReset();
  restHandlers.patch.mockReset();
  restHandlers.put.mockReset();
  restHandlers.delete.mockReset();
  restHandlers.get.mockImplementation(async () => []);
  restHandlers.post.mockImplementation(async () => ({ id: "m-1", channel_id: "c" }));
  restHandlers.patch.mockImplementation(async () => ({}));
});

afterEach(() => {
  clearLiveEnv();
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (k.startsWith("OPENCLAW_LIVE_DISCORD")) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
});

describe("resolveDiscordE2EEnv", () => {
  it("throws and lists every missing variable", () => {
    expect(() => resolveDiscordE2EEnv()).toThrow(/missing.*OPENCLAW_LIVE_DISCORD_BOT_TOKEN/);
    expect(() => resolveDiscordE2EEnv()).toThrow(/OPENCLAW_LIVE_DISCORD_GUILD_ID/);
    expect(() => resolveDiscordE2EEnv()).toThrow(/OPENCLAW_LIVE_DISCORD_PARENT_CHANNEL_ID/);
  });

  it("throws when only some variables are set", () => {
    process.env.OPENCLAW_LIVE_DISCORD_BOT_TOKEN = "tok";
    expect(() => resolveDiscordE2EEnv()).toThrow(/OPENCLAW_LIVE_DISCORD_GUILD_ID/);
    expect(() => resolveDiscordE2EEnv()).toThrow(/OPENCLAW_LIVE_DISCORD_PARENT_CHANNEL_ID/);
  });

  it("returns env when all required vars are set", () => {
    process.env.OPENCLAW_LIVE_DISCORD_BOT_TOKEN = "tok";
    process.env.OPENCLAW_LIVE_DISCORD_GUILD_ID = "guild-1";
    process.env.OPENCLAW_LIVE_DISCORD_PARENT_CHANNEL_ID = "chan-1";
    const env = resolveDiscordE2EEnv();
    expect(env).toEqual({
      botToken: "tok",
      guildId: "guild-1",
      parentChannelId: "chan-1",
      accountId: "default",
      secondaryChannelId: undefined,
    });
  });

  it("uses overrides for account id and secondary channel", () => {
    process.env.OPENCLAW_LIVE_DISCORD_BOT_TOKEN = "tok";
    process.env.OPENCLAW_LIVE_DISCORD_GUILD_ID = "guild-1";
    process.env.OPENCLAW_LIVE_DISCORD_PARENT_CHANNEL_ID = "chan-1";
    process.env.OPENCLAW_LIVE_DISCORD_ACCOUNT_ID = "alt";
    process.env.OPENCLAW_LIVE_DISCORD_SECONDARY_CHANNEL_ID = "chan-2";
    const env = resolveDiscordE2EEnv();
    expect(env.accountId).toBe("alt");
    expect(env.secondaryChannelId).toBe("chan-2");
  });

  it("treats whitespace-only values as missing", () => {
    process.env.OPENCLAW_LIVE_DISCORD_BOT_TOKEN = "   ";
    process.env.OPENCLAW_LIVE_DISCORD_GUILD_ID = "guild-1";
    process.env.OPENCLAW_LIVE_DISCORD_PARENT_CHANNEL_ID = "chan-1";
    expect(() => resolveDiscordE2EEnv()).toThrow(/OPENCLAW_LIVE_DISCORD_BOT_TOKEN/);
  });
});

describe("isDiscordE2EEnabled", () => {
  it("returns false when the master flag is off", () => {
    expect(isDiscordE2EEnabled({})).toBe(false);
  });

  it("returns false when flag is on but required vars are missing", () => {
    expect(
      isDiscordE2EEnabled({
        OPENCLAW_LIVE_DISCORD: "1",
      }),
    ).toBe(false);
  });

  it("returns false when only some required vars are set", () => {
    expect(
      isDiscordE2EEnabled({
        OPENCLAW_LIVE_DISCORD: "1",
        OPENCLAW_LIVE_DISCORD_BOT_TOKEN: "tok",
      }),
    ).toBe(false);
  });

  it("returns true when flag is on and all required vars present", () => {
    expect(
      isDiscordE2EEnabled({
        OPENCLAW_LIVE_DISCORD: "1",
        OPENCLAW_LIVE_DISCORD_BOT_TOKEN: "tok",
        OPENCLAW_LIVE_DISCORD_GUILD_ID: "g",
        OPENCLAW_LIVE_DISCORD_PARENT_CHANNEL_ID: "c",
      }),
    ).toBe(true);
  });

  it("treats empty/whitespace values as missing", () => {
    expect(
      isDiscordE2EEnabled({
        OPENCLAW_LIVE_DISCORD: "1",
        OPENCLAW_LIVE_DISCORD_BOT_TOKEN: "",
        OPENCLAW_LIVE_DISCORD_GUILD_ID: "g",
        OPENCLAW_LIVE_DISCORD_PARENT_CHANNEL_ID: "c",
      }),
    ).toBe(false);
  });

  it("honors truthy variants of the master flag", () => {
    for (const flag of ["1", "true", "TRUE", "yes"]) {
      expect(
        isDiscordE2EEnabled({
          OPENCLAW_LIVE_DISCORD: flag,
          OPENCLAW_LIVE_DISCORD_BOT_TOKEN: "tok",
          OPENCLAW_LIVE_DISCORD_GUILD_ID: "g",
          OPENCLAW_LIVE_DISCORD_PARENT_CHANNEL_ID: "c",
        }),
      ).toBe(true);
    }
  });

  it("treats falsy flag values as disabled", () => {
    for (const flag of ["0", "false", "no", ""]) {
      expect(
        isDiscordE2EEnabled({
          OPENCLAW_LIVE_DISCORD: flag,
          OPENCLAW_LIVE_DISCORD_BOT_TOKEN: "tok",
          OPENCLAW_LIVE_DISCORD_GUILD_ID: "g",
          OPENCLAW_LIVE_DISCORD_PARENT_CHANNEL_ID: "c",
        }),
      ).toBe(false);
    }
  });
});

describe("FORBIDDEN_CHATTER_DEFAULT", () => {
  it("contains all canonical forbidden phrases", () => {
    const stringify = (entry: string | RegExp) =>
      typeof entry === "string" ? entry : entry.source;
    const flat = FORBIDDEN_CHATTER_DEFAULT.map(stringify);
    expect(flat).toContain("Using browser-autopilot");
    expect(flat).toContain("Back online");
    expect(flat).toContain("Background task done");
    expect(flat).toContain("CLI fallback");
    expect(flat).toContain("thread lookup");
    expect(flat.some((p) => /temp-dir/i.test(p))).toBe(true);
    expect(flat.some((p) => /sandbox debugging/i.test(p))).toBe(true);
  });
});

describe("assertNoForbiddenChatter", () => {
  const env = {
    botToken: "tok",
    guildId: "g",
    parentChannelId: "c",
    accountId: "default",
  };

  it("passes when no forbidden pattern is present", async () => {
    restHandlers.get.mockImplementation(async () => [
      { id: "1", content: "hello world", author: {}, timestamp: "2026-04-17T00:00:00Z" },
    ]);
    await expect(
      assertNoForbiddenChatter({
        threadId: "thread-1",
        env,
      }),
    ).resolves.toBeUndefined();
    expect(restHandlers.get).toHaveBeenCalled();
  });

  it("detects each forbidden substring/pattern", async () => {
    const samples = [
      "Using browser-autopilot",
      "Back online",
      "Background task done",
      "CLI fallback",
      "/tmp/temp-dir/x",
      "thread lookup",
      "sandbox debugging",
    ];
    for (const sample of samples) {
      restHandlers.get.mockImplementation(async () => [
        { id: "1", content: sample, author: {}, timestamp: "2026-04-17T00:00:00Z" },
      ]);
      await expect(
        assertNoForbiddenChatter({
          threadId: "thread-1",
          env,
        }),
      ).rejects.toThrow(/forbidden pattern hit/);
    }
  });

  it("respects custom forbidden list overrides", async () => {
    restHandlers.get.mockImplementation(async () => [
      { id: "1", content: "Using browser-autopilot", author: {}, timestamp: "t" },
    ]);
    await expect(
      assertNoForbiddenChatter({
        threadId: "t",
        env,
        forbidden: ["only-this"],
      }),
    ).resolves.toBeUndefined();
  });
});

describe("assertAuthorIdentity", () => {
  it("passes when webhook identity matches expected", () => {
    const message = fakeMessage({
      author: { id: "x", username: "⚙ claude", webhook_id: "wh-1", bot: true },
    });
    expect(() =>
      assertAuthorIdentity(message, {
        webhookId: "present",
        username: /⚙ claude/,
      }),
    ).not.toThrow();
  });

  it("fails when bot identity is present but webhook expected", () => {
    const message = fakeMessage({
      author: { id: "x", username: "richardbots", bot: true },
    });
    expect(() =>
      assertAuthorIdentity(message, {
        webhookId: "present",
        username: /⚙ claude/,
      }),
    ).toThrow(/expected webhook author/);
  });

  it("fails when webhook is present but expected absent", () => {
    const message = fakeMessage({
      author: { id: "x", username: "⚙ claude", webhook_id: "wh-1", bot: true },
    });
    expect(() => assertAuthorIdentity(message, { webhookId: "absent" })).toThrow(
      /expected non-webhook/,
    );
  });

  it("fails on username mismatch", () => {
    const message = fakeMessage({
      author: { id: "x", username: "someone-else", webhook_id: "wh-1" },
    });
    expect(() =>
      assertAuthorIdentity(message, {
        webhookId: "present",
        username: "⚙ claude",
      }),
    ).toThrow(/username mismatch/);
  });

  it("fails on bot flag mismatch", () => {
    const message = fakeMessage({
      author: { id: "x", username: "⚙ claude", webhook_id: "wh-1", bot: false },
    });
    expect(() =>
      assertAuthorIdentity(message, {
        webhookId: "present",
        bot: true,
      }),
    ).toThrow(/bot flag mismatch/);
  });
});

describe("withDiscordRetry", () => {
  it("returns on first success", async () => {
    const fn = vi.fn().mockResolvedValueOnce("ok");
    const result = await withDiscordRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient error", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    const result = await withDiscordRetry(fn, { maxAttempts: 4, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after max attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("nope"));
    await expect(withDiscordRetry(fn, { maxAttempts: 2, baseDelayMs: 1 })).rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("honors retry-after on 429 responses", async () => {
    const rateErr: { status: number; retry_after: number; message: string } = {
      status: 429,
      retry_after: 0.02,
      message: "rate-limited",
    };
    const fn = vi.fn().mockRejectedValueOnce(rateErr).mockResolvedValueOnce("ok");
    const start = Date.now();
    const result = await withDiscordRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    const elapsed = Date.now() - start;
    expect(result).toBe("ok");
    // Expect at least the retry-after seconds; bounded by jitter window.
    expect(elapsed).toBeGreaterThanOrEqual(15);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("LEAK_PATTERNS_DEFAULT", () => {
  it("matches canonical red-team leak shapes", () => {
    const shouldMatch = [
      "before /home/richard/tmp/SECRET_FILE.txt after",
      "before /Users/alice/Documents/x.pdf after",
      "before /root/secrets/creds.log after",
      "before C:\\Users\\alice\\Downloads\\x.pdf after",
      "Authorization: Bearer fake_abc123def456ghi789jkl here",
      "ANTHROPIC_API_KEY=sk-ant-fake123",
      "OPENAI_API_KEY=sk-fake456",
      "token=ghp_fakegithubpat789",
      "    at handler (/path/file.ts:42:17)",
    ];
    for (const sample of shouldMatch) {
      const matched = LEAK_PATTERNS_DEFAULT.some((p) =>
        typeof p === "string" ? sample.includes(p) : p.test(sample),
      );
      expect([sample, matched]).toEqual([sample, true]);
    }
  });

  it("does not match sanitized forms", () => {
    const shouldNotMatch = [
      "I wrote ~/tmp/SECRET_FILE.txt OK",
      "Authorization: Bearer [redacted]",
      "ANTHROPIC_API_KEY=[redacted]",
      "OPENAI_API_KEY=[redacted]",
      "token=[redacted-github-pat]",
      "Merged feat/x into main.",
    ];
    for (const sample of shouldNotMatch) {
      const matched = LEAK_PATTERNS_DEFAULT.some((p) =>
        typeof p === "string" ? sample.includes(p) : p.test(sample),
      );
      expect([sample, matched]).toEqual([sample, false]);
    }
  });
});

describe("assertContentScrubbed", () => {
  it("passes when leak is absent", () => {
    expect(() =>
      assertContentScrubbed("Wrote ~/tmp/SECRET_FILE.txt", {
        leak: "/home/richard/tmp/SECRET_FILE.txt",
      }),
    ).not.toThrow();
  });

  it("fails when leak is present", () => {
    expect(() =>
      assertContentScrubbed("I leaked /home/richard/tmp/SECRET_FILE.txt", {
        leak: "/home/richard/tmp/SECRET_FILE.txt",
        label: "posix-home",
      }),
    ).toThrow(/posix-home.*still present/);
  });

  it("supports regex leak patterns", () => {
    expect(() =>
      assertContentScrubbed("contains sk-fakeABCDEF", {
        leak: /sk-[a-z]+[A-Z]+/,
      }),
    ).toThrow(/still present/);
  });

  it("passes when leak absent and scrubbed form present", () => {
    expect(() =>
      assertContentScrubbed("Wrote ~/tmp/SECRET_FILE.txt", {
        leak: "/home/richard/tmp/SECRET_FILE.txt",
        expectedScrubbedForm: "~/tmp/SECRET_FILE.txt",
      }),
    ).not.toThrow();
  });

  it("fails when leak absent but expected scrubbed form missing", () => {
    expect(() =>
      assertContentScrubbed("content without any path at all", {
        leak: "/home/richard/tmp/SECRET_FILE.txt",
        expectedScrubbedForm: "~/tmp/SECRET_FILE.txt",
      }),
    ).toThrow(/expected scrubbed form .* missing/);
  });

  it("supports regex expectedScrubbedForm", () => {
    expect(() =>
      assertContentScrubbed("Bearer [redacted] here", {
        leak: "Bearer secret",
        expectedScrubbedForm: /Bearer \[redacted\]/,
      }),
    ).not.toThrow();
  });

  it("truncates long content in the error message", () => {
    const content = `${"x".repeat(2000)}LEAK${"y".repeat(2000)}`;
    let captured: unknown;
    try {
      assertContentScrubbed(content, { leak: "LEAK" });
    } catch (err) {
      captured = err;
    }
    expect((captured as Error).message).toMatch(/still present/);
    // Should have truncated rather than dumped the full 4000+ char content.
    expect((captured as Error).message.length).toBeLessThan(1200);
  });
});

describe("assertNoLeaksInThread", () => {
  const env = {
    botToken: "tok",
    guildId: "g",
    parentChannelId: "c",
    accountId: "default",
  };

  it("passes when thread messages contain no leak patterns", async () => {
    restHandlers.get.mockImplementation(async () => [
      { id: "1", content: "All good. Wrote ~/tmp/x.txt.", author: {}, timestamp: "t" },
      { id: "2", content: "Bearer [redacted]", author: {}, timestamp: "t" },
    ]);
    await expect(
      assertNoLeaksInThread({
        threadId: "thread-1",
        env,
      }),
    ).resolves.toBeUndefined();
  });

  it("flags each canonical leak shape when present", async () => {
    const offenders = [
      "Leaked /home/richard/tmp/SECRET_FILE.txt",
      "Leaked /Users/bob/creds.txt",
      "Leaked /root/envrc",
      "Leaked C:\\Users\\carol\\secret.txt",
      "Authorization: Bearer fake_abc123def456ghi789jkl",
      "key=sk-ant-fake123abcdef",
      "key=sk-fakeABCDEF123456",
      "tok=ghp_fakegithubpat123abc",
      "Trace:\n    at handler (/src/x.ts:10:5)",
    ];
    for (const content of offenders) {
      restHandlers.get.mockImplementation(async () => [
        { id: "m", content, author: {}, timestamp: "t" },
      ]);
      await expect(
        assertNoLeaksInThread({
          threadId: "t",
          env,
        }),
      ).rejects.toThrow(/leak pattern hit/);
    }
  });

  it("respects custom leak list overrides", async () => {
    restHandlers.get.mockImplementation(async () => [
      { id: "1", content: "/home/alice/foo", author: {}, timestamp: "t" },
    ]);
    await expect(
      assertNoLeaksInThread({
        threadId: "t",
        env,
        leaks: ["something-else"],
      }),
    ).resolves.toBeUndefined();
  });
});

// --- test utilities ----------------------------------------------------------

type FakeAuthor = {
  id: string;
  username?: string;
  bot?: boolean;
  webhook_id?: string;
};

function fakeMessage(opts: { author: FakeAuthor; content?: string }) {
  // webhook_id belongs on the APIMessage itself, but tests pass it via the
  // author object for ergonomics; we lift it onto the outer message here.
  const { webhook_id, ...author } = opts.author;
  return {
    id: "m-1",
    content: opts.content ?? "hi",
    timestamp: "2026-04-17T00:00:00Z",
    author,
    ...(webhook_id !== undefined ? { webhook_id } : {}),
  } as unknown as import("discord-api-types/v10").APIMessage;
}
