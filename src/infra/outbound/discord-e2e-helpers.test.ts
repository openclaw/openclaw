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
  archiveThreadDiscord,
  assertAuthorIdentity,
  assertContentScrubbed,
  assertNoForbiddenChatter,
  assertNoLeaksInThread,
  assertVisibleInThread,
  isDiscordE2EEnabled,
  listActiveThreadsInParent,
  nudgeBoundSession,
  readMessagesInThread,
  rebindParentToNewThread,
  resolveDiscordE2EEnv,
  waitForMarkerInNewThread,
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

  // --- Exclusion-aware scan (Task 3) ---------------------------------------
  //
  // The red-team harness embeds the forbidden phrase in the PROMPT message
  // so the scan can tell whether the child agent echoed the phrase back
  // into its visible reply. Without excluding the harness request the scan
  // would fail on the prompt itself — failing for harness reasons, not
  // assistant reasons. These tests cover the exclusion contract.

  it("ignores excluded request messages even when they contain forbidden phrases", async () => {
    restHandlers.get.mockImplementation(async () => [
      {
        id: "req-1",
        content: "Remember: do NOT say Using browser-autopilot in your reply.",
        author: { id: "u", username: "openclaw-e2e", bot: true },
        timestamp: "2026-04-17T00:00:00Z",
      },
      {
        id: "wh-reply",
        content: "Got it.",
        author: { id: "a", username: "⚙ claude", bot: true },
        webhook_id: "wh-1",
        timestamp: "2026-04-17T00:00:30Z",
      },
    ]);
    await expect(
      assertNoForbiddenChatter({
        threadId: "t",
        env,
        excludeMessageIds: ["req-1"],
      }),
    ).resolves.toBeUndefined();
  });

  it("still flags assistant reply even when request message is excluded", async () => {
    restHandlers.get.mockImplementation(async () => [
      {
        id: "req-1",
        content: "Do not use the forbidden phrase.",
        author: { id: "u", username: "openclaw-e2e", bot: true },
        timestamp: "2026-04-17T00:00:00Z",
      },
      {
        id: "wh-reply",
        content: "Using browser-autopilot to do the work.",
        author: { id: "a", username: "⚙ claude", bot: true },
        webhook_id: "wh-1",
        timestamp: "2026-04-17T00:00:30Z",
      },
    ]);
    await expect(
      assertNoForbiddenChatter({
        threadId: "t",
        env,
        excludeMessageIds: ["req-1"],
      }),
    ).rejects.toThrow(/forbidden pattern hit/);
  });

  it("authorship:webhook-only ignores bot/user messages entirely for chatter scan", async () => {
    // A bot-authored post (the harness request echo, or any other non-webhook
    // surface) carries the forbidden phrase. Assistant reply is clean.
    // Under authorship: "webhook-only" the scan must ignore the bot-authored
    // post outright and pass.
    restHandlers.get.mockImplementation(async () => [
      {
        id: "bot-post",
        content: "Using browser-autopilot reminder",
        author: { id: "u", username: "openclaw-e2e", bot: true },
        timestamp: "2026-04-17T00:00:00Z",
      },
      {
        id: "wh-reply",
        content: "Clean reply.",
        author: { id: "a", username: "⚙ claude", bot: true },
        webhook_id: "wh-1",
        timestamp: "2026-04-17T00:00:30Z",
      },
    ]);
    await expect(
      assertNoForbiddenChatter({
        threadId: "t",
        env,
        authorship: "webhook-only",
      }),
    ).resolves.toBeUndefined();
  });

  it("authorship:webhook-only still flags forbidden text in webhook-authored replies", async () => {
    restHandlers.get.mockImplementation(async () => [
      {
        id: "wh-reply",
        content: "Using browser-autopilot to do the work.",
        author: { id: "a", username: "⚙ claude", bot: true },
        webhook_id: "wh-1",
        timestamp: "2026-04-17T00:00:30Z",
      },
    ]);
    await expect(
      assertNoForbiddenChatter({
        threadId: "t",
        env,
        authorship: "webhook-only",
      }),
    ).rejects.toThrow(/forbidden pattern hit/);
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

  // --- Exclusion-aware scan (Task 3) ---------------------------------------
  //
  // The red-team harness embeds the leak string in the prompt so the child
  // has the opportunity to echo it back. Without excluding the harness
  // request the scan flags the prompt itself — failing for harness
  // reasons, not assistant reasons.

  it("ignores excluded request messages even when they contain leaks", async () => {
    restHandlers.get.mockImplementation(async () => [
      {
        id: "req-1",
        content: "Context path: /home/richard/tmp/SECRET_FILE.txt (do not repeat)",
        author: { id: "u", username: "openclaw-e2e", bot: true },
        timestamp: "2026-04-17T00:00:00Z",
      },
      {
        id: "wh-reply",
        content: "Understood. Wrote ~/tmp/SECRET_FILE.txt.",
        author: { id: "a", username: "⚙ claude", bot: true },
        webhook_id: "wh-1",
        timestamp: "2026-04-17T00:00:30Z",
      },
    ]);
    await expect(
      assertNoLeaksInThread({
        threadId: "t",
        env,
        excludeMessageIds: ["req-1"],
      }),
    ).resolves.toBeUndefined();
  });

  it("still flags leaks in assistant reply when request is excluded", async () => {
    restHandlers.get.mockImplementation(async () => [
      {
        id: "req-1",
        content: "Remember not to leak the absolute path.",
        author: { id: "u", username: "openclaw-e2e", bot: true },
        timestamp: "2026-04-17T00:00:00Z",
      },
      {
        id: "wh-reply",
        content: "Wrote /home/richard/tmp/SECRET_FILE.txt",
        author: { id: "a", username: "⚙ claude", bot: true },
        webhook_id: "wh-1",
        timestamp: "2026-04-17T00:00:30Z",
      },
    ]);
    await expect(
      assertNoLeaksInThread({
        threadId: "t",
        env,
        excludeMessageIds: ["req-1"],
      }),
    ).rejects.toThrow(/leak pattern hit/);
  });

  it("authorship:webhook-only ignores bot/user messages entirely for leaks scan", async () => {
    restHandlers.get.mockImplementation(async () => [
      {
        id: "bot-post",
        content: "/home/richard/tmp/SECRET_FILE.txt",
        author: { id: "u", username: "openclaw-e2e", bot: true },
        timestamp: "2026-04-17T00:00:00Z",
      },
      {
        id: "wh-reply",
        content: "Clean reply.",
        author: { id: "a", username: "⚙ claude", bot: true },
        webhook_id: "wh-1",
        timestamp: "2026-04-17T00:00:30Z",
      },
    ]);
    await expect(
      assertNoLeaksInThread({
        threadId: "t",
        env,
        authorship: "webhook-only",
      }),
    ).resolves.toBeUndefined();
  });

  it("authorship:webhook-only still flags leaks in webhook-authored replies", async () => {
    restHandlers.get.mockImplementation(async () => [
      {
        id: "wh-reply",
        content: "Wrote /home/richard/tmp/SECRET_FILE.txt",
        author: { id: "a", username: "⚙ claude", bot: true },
        webhook_id: "wh-1",
        timestamp: "2026-04-17T00:00:30Z",
      },
    ]);
    await expect(
      assertNoLeaksInThread({
        threadId: "t",
        env,
        authorship: "webhook-only",
      }),
    ).rejects.toThrow(/leak pattern hit/);
  });
});

// --- Phase 7 P2 matrix helpers ------------------------------------------------
//
// These tests cover the helpers added for the 10-scenario Phase 7 P2 matrix.
// They are all pure unit tests that mock `@buape/carbon`'s RequestClient and
// verify the helpers hit the expected Discord REST routes with the expected
// payload shape, and that gateway RPCs are issued correctly. No network I/O.

describe("archiveThreadDiscord", () => {
  const env = {
    botToken: "tok",
    guildId: "g",
    parentChannelId: "c",
    accountId: "default",
  };

  it("patches the thread with archived=true and default locked=false", async () => {
    await archiveThreadDiscord({ threadId: "thread-42", env });
    expect(restHandlers.patch).toHaveBeenCalledTimes(1);
    const [route, payload] = restHandlers.patch.mock.calls[0] as [string, { body: unknown }];
    expect(typeof route).toBe("string");
    expect(route).toContain("thread-42");
    expect(payload.body).toEqual({ archived: true, locked: false });
  });

  it("patches the thread with locked=true when requested", async () => {
    await archiveThreadDiscord({ threadId: "thread-43", env, locked: true });
    const [, payload] = restHandlers.patch.mock.calls[0] as [string, { body: unknown }];
    expect(payload.body).toEqual({ archived: true, locked: true });
  });

  it("surfaces the underlying REST error (not swallowed like cleanup)", async () => {
    // archiveThreadDiscord wraps in withDiscordRetry, so we must reject on
    // every attempt to prove the final error propagates up (vs cleanupBinding
    // which swallows failures by design).
    restHandlers.patch.mockImplementation(async () => {
      throw new Error("forbidden");
    });
    await expect(archiveThreadDiscord({ threadId: "thread-err", env })).rejects.toThrow(
      /forbidden/,
    );
  }, 15_000);
});

describe("listActiveThreadsInParent", () => {
  const env = {
    botToken: "tok",
    guildId: "g-1",
    parentChannelId: "chan-main",
    accountId: "default",
  };

  it("returns threads whose parent_id matches the configured parent", async () => {
    restHandlers.get.mockImplementation(async () => ({
      threads: [
        { id: "t-1", parent_id: "chan-main", name: "a" },
        { id: "t-2", parent_id: "chan-other", name: "b" },
        { id: "t-3", parent_id: "chan-main", name: "c" },
      ],
    }));
    const result = await listActiveThreadsInParent({ env });
    expect(result.map((t) => t.id)).toEqual(["t-1", "t-3"]);
  });

  it("honors explicit parentChannelId override", async () => {
    restHandlers.get.mockImplementation(async () => ({
      threads: [
        { id: "t-1", parent_id: "chan-main", name: "a" },
        { id: "t-2", parent_id: "chan-alt", name: "b" },
      ],
    }));
    const result = await listActiveThreadsInParent({ env, parentChannelId: "chan-alt" });
    expect(result.map((t) => t.id)).toEqual(["t-2"]);
  });

  it("returns threads with missing parent_id alongside matches", async () => {
    // Some Discord payloads omit parent_id for certain thread shapes. The
    // helper accepts those as matches so they are not silently filtered out.
    restHandlers.get.mockImplementation(async () => ({
      threads: [
        { id: "t-1", name: "no-parent" },
        { id: "t-2", parent_id: "chan-main", name: "matches" },
      ],
    }));
    const result = await listActiveThreadsInParent({ env });
    expect(result.map((t) => t.id)).toEqual(["t-1", "t-2"]);
  });

  it("returns empty array when guild has no active threads", async () => {
    restHandlers.get.mockImplementation(async () => ({}));
    const result = await listActiveThreadsInParent({ env });
    expect(result).toEqual([]);
  });
});

describe("readMessagesInThread", () => {
  const env = {
    botToken: "tok",
    guildId: "g",
    parentChannelId: "c",
    accountId: "default",
  };

  it("returns raw messages without asserting anything", async () => {
    restHandlers.get.mockImplementation(async () => [
      { id: "m1", content: "one", author: {}, timestamp: "t" },
      { id: "m2", content: "two", author: {}, timestamp: "t" },
    ]);
    const result = await readMessagesInThread({ threadId: "thread-x", env });
    expect(result.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("clamps limit to [1, 100]", async () => {
    restHandlers.get.mockImplementation(async () => []);
    await readMessagesInThread({ threadId: "t", env, limit: 1000 });
    // carbon's RequestClient signature passes query as the second arg
    const call = restHandlers.get.mock.calls[0] as [string, { limit: number }];
    expect(call[1].limit).toBe(100);
    await readMessagesInThread({ threadId: "t", env, limit: 0 });
    const second = restHandlers.get.mock.calls[1] as [string, { limit: number }];
    expect(second[1].limit).toBe(1);
  });

  it("defaults to 50 when limit is omitted", async () => {
    restHandlers.get.mockImplementation(async () => []);
    await readMessagesInThread({ threadId: "t", env });
    const call = restHandlers.get.mock.calls[0] as [string, { limit: number }];
    expect(call[1].limit).toBe(50);
  });
});

describe("nudgeBoundSession", () => {
  const env = {
    botToken: "tok",
    guildId: "g",
    parentChannelId: "c",
    accountId: "alt-account",
  };

  it("issues chat.send with originating target = boundTarget and returns promptly", async () => {
    const request = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      status: "started",
      runId: "run-1",
    }));
    const gateway = { request } as unknown as import("../../gateway/client.js").GatewayClient;
    await nudgeBoundSession({
      spawnedSessionKey: "acp:claude:abc",
      text: "nudge body",
      boundTarget: "thread-archived",
      env,
      gateway,
    });
    expect(request).toHaveBeenCalledTimes(1);
    const [method, payload] = request.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe("chat.send");
    expect(payload.sessionKey).toBe("acp:claude:abc");
    expect(payload.message).toBe("nudge body");
    expect(payload.originatingChannel).toBe("discord");
    expect(payload.originatingTo).toBe("thread-archived");
    expect(payload.originatingAccountId).toBe("alt-account");
    expect(typeof payload.idempotencyKey).toBe("string");
  });

  it("does NOT call agent.wait (fire-and-observe pattern)", async () => {
    const request = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      status: "started",
      runId: "run-1",
    }));
    const gateway = { request } as unknown as import("../../gateway/client.js").GatewayClient;
    await nudgeBoundSession({
      spawnedSessionKey: "k",
      text: "t",
      boundTarget: "x",
      env,
      gateway,
    });
    const methods = request.mock.calls.map((c) => c[0]);
    expect(methods).not.toContain("agent.wait");
    expect(methods).toEqual(["chat.send"]);
  });
});

describe("rebindParentToNewThread", () => {
  const envWithSecondary = {
    botToken: "tok",
    guildId: "g",
    parentChannelId: "chan-main",
    accountId: "default",
    secondaryChannelId: "chan-secondary",
  };
  const envWithoutSecondary = {
    botToken: "tok",
    guildId: "g",
    parentChannelId: "chan-main",
    accountId: "default",
  };

  it("creates a new thread in the secondary channel and issues a rebind RPC", async () => {
    restHandlers.post.mockImplementation(async () => ({ id: "new-thread-1" }));
    const request = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      status: "started",
      runId: "r",
    }));
    const gateway = { request } as unknown as import("../../gateway/client.js").GatewayClient;
    const out = await rebindParentToNewThread({
      parentSessionKey: "parent-key",
      env: envWithSecondary,
      gateway,
    });
    expect(out.newThreadId).toBe("new-thread-1");
    expect(out.newParentChannelId).toBe("chan-secondary");
    // Thread creation hit the threads route.
    expect(restHandlers.post).toHaveBeenCalledTimes(1);
    const [route] = restHandlers.post.mock.calls[0] as [string, { body: unknown }];
    expect(typeof route).toBe("string");
    expect(route).toContain("chan-secondary");
    // Rebind RPC was dispatched with the new thread id.
    expect(request).toHaveBeenCalledTimes(1);
    const [method, payload] = request.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe("chat.send");
    expect(payload.message).toBe("/acp rebind --thread new-thread-1");
    expect(payload.originatingTo).toBe("new-thread-1");
  });

  it("accepts explicit newParentChannelId override", async () => {
    restHandlers.post.mockImplementation(async () => ({ id: "new-thread-2" }));
    const request = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({}));
    const gateway = { request } as unknown as import("../../gateway/client.js").GatewayClient;
    const out = await rebindParentToNewThread({
      parentSessionKey: "k",
      newParentChannelId: "explicit-chan",
      env: envWithoutSecondary,
      gateway,
    });
    expect(out.newParentChannelId).toBe("explicit-chan");
    const [route] = restHandlers.post.mock.calls[0] as [string, { body: unknown }];
    expect(route).toContain("explicit-chan");
  });

  it("throws a clear error when neither newParentChannelId nor secondaryChannelId is set", async () => {
    const request = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({}));
    const gateway = { request } as unknown as import("../../gateway/client.js").GatewayClient;
    await expect(
      rebindParentToNewThread({
        parentSessionKey: "k",
        env: envWithoutSecondary,
        gateway,
      }),
    ).rejects.toThrow(/OPENCLAW_LIVE_DISCORD_SECONDARY_CHANNEL_ID|newParentChannelId/);
    // No thread creation should have happened.
    expect(restHandlers.post).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("waitForMarkerInNewThread", () => {
  const env = {
    botToken: "tok",
    guildId: "g",
    parentChannelId: "chan-main",
    accountId: "default",
  };

  it("returns the first thread other than excludeThreadId that contains the marker", async () => {
    // First REST call: list active threads.
    // Second REST call: read thread-a messages (has marker).
    // Test uses mockImplementation that responds by route via url inspection.
    restHandlers.get.mockImplementation(async (...args: unknown[]) => {
      const route = typeof args[0] === "string" ? args[0] : "";
      if (route.includes("/threads/active")) {
        return {
          threads: [
            { id: "thread-old", parent_id: "chan-main", name: "old" },
            { id: "thread-new", parent_id: "chan-main", name: "new" },
          ],
        };
      }
      if (route.includes("thread-new")) {
        return [
          {
            id: "m-1",
            content: "hello MARK-42 world",
            author: {},
            timestamp: "2026-04-17T00:00:00Z",
          },
        ];
      }
      // thread-old reads would return empty
      return [];
    });
    const result = await waitForMarkerInNewThread({
      env,
      marker: "MARK-42",
      excludeThreadId: "thread-old",
      timeoutMs: 5_000,
    });
    expect(result.newThreadId).toBe("thread-new");
    expect(result.message.id).toBe("m-1");
  });

  it("throws when no new thread carries the marker before timeout", async () => {
    restHandlers.get.mockImplementation(async (...args: unknown[]) => {
      const route = typeof args[0] === "string" ? args[0] : "";
      if (route.includes("/threads/active")) {
        return {
          threads: [{ id: "thread-old", parent_id: "chan-main", name: "old" }],
        };
      }
      return [];
    });
    await expect(
      waitForMarkerInNewThread({
        env,
        marker: "UNFOUND",
        excludeThreadId: "thread-old",
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/not seen in any thread other than thread-old/);
  });

  it("ignores excluded thread even if it contains the marker", async () => {
    restHandlers.get.mockImplementation(async (...args: unknown[]) => {
      const route = typeof args[0] === "string" ? args[0] : "";
      if (route.includes("/threads/active")) {
        return {
          threads: [{ id: "thread-old", parent_id: "chan-main", name: "old-has-marker" }],
        };
      }
      // thread-old has the marker — helper must still NOT return it.
      if (route.includes("thread-old")) {
        return [{ id: "m-old", content: "MARK-x is here", author: {}, timestamp: "t" }];
      }
      return [];
    });
    await expect(
      waitForMarkerInNewThread({
        env,
        marker: "MARK-x",
        excludeThreadId: "thread-old",
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/not seen in any thread other than thread-old/);
  });

  it("survives transient read failures on individual threads", async () => {
    let messageCallCount = 0;
    restHandlers.get.mockImplementation(async (...args: unknown[]) => {
      const route = typeof args[0] === "string" ? args[0] : "";
      if (route.includes("/threads/active")) {
        return {
          threads: [
            { id: "thread-broken", parent_id: "chan-main", name: "broken" },
            { id: "thread-ok", parent_id: "chan-main", name: "ok" },
          ],
        };
      }
      if (route.includes("thread-broken")) {
        // Always fail. Helper should skip it and try thread-ok next.
        throw new Error("read forbidden");
      }
      if (route.includes("thread-ok")) {
        messageCallCount += 1;
        return [
          {
            id: `m-${messageCallCount}`,
            content: "FOUND-marker here",
            author: {},
            timestamp: "t",
          },
        ];
      }
      return [];
    });
    const result = await waitForMarkerInNewThread({
      env,
      marker: "FOUND-marker",
      excludeThreadId: "thread-other",
      timeoutMs: 10_000,
    });
    expect(result.newThreadId).toBe("thread-ok");
  });
});

describe("assertVisibleInThread", () => {
  const env = {
    botToken: "tok",
    guildId: "g",
    parentChannelId: "c",
    accountId: "default",
  };

  it("falls back to earliest user/bot match on timeout only when diagnostic fallback is opted in", async () => {
    // Two user/bot-authored messages containing the marker. No webhook
    // match will ever arrive. Under the Task-2 strict default the helper
    // MUST throw rather than silently falling back. Only when callers
    // explicitly opt into `allowDiagnosticFallback: true` does the helper
    // return the earliest non-webhook match by timestamp.
    restHandlers.get.mockImplementation(async () => [
      {
        id: "m-late",
        content: "hello MARKER-x world",
        author: { id: "u1", username: "openclaw-e2e", bot: true },
        timestamp: "2026-04-17T00:00:10Z",
      },
      {
        id: "m-early",
        content: "hello MARKER-x earlier",
        author: { id: "u1", username: "openclaw-e2e", bot: true },
        timestamp: "2026-04-17T00:00:01Z",
      },
    ]);
    const msg = await assertVisibleInThread({
      threadId: "t",
      env,
      marker: "MARKER-x",
      timeoutMs: 200,
      allowDiagnosticFallback: true,
    });
    expect(msg.id).toBe("m-early");
  });

  it("returns earliest webhook match when only webhook-authored matches exist", async () => {
    restHandlers.get.mockImplementation(async () => [
      {
        id: "wh-late",
        content: "MARKER-y later",
        author: { id: "a", username: "⚙ claude", bot: true },
        webhook_id: "wh-1",
        timestamp: "2026-04-17T00:00:20Z",
      },
      {
        id: "wh-early",
        content: "MARKER-y earlier",
        author: { id: "a", username: "⚙ claude", bot: true },
        webhook_id: "wh-1",
        timestamp: "2026-04-17T00:00:05Z",
      },
    ]);
    const msg = await assertVisibleInThread({
      threadId: "t",
      env,
      marker: "MARKER-y",
      timeoutMs: 2_000,
    });
    expect(msg.id).toBe("wh-early");
  });

  it("prefers webhook-authored match over earlier user/bot-authored match (no wait)", async () => {
    // This is the canonical harness scenario: the harness posts the user's
    // task message containing the marker BEFORE the child's webhook reply.
    // The webhook reply arrives later (larger timestamp). Both are already
    // present when the helper polls, so the helper must return the webhook
    // reply immediately (not wait for timeout).
    restHandlers.get.mockImplementation(async () => [
      {
        id: "user-echo",
        content: "your task: do thing MARKER-z",
        author: { id: "u", username: "openclaw-e2e", bot: true },
        // No webhook_id — bot-authored.
        timestamp: "2026-04-17T00:00:01Z",
      },
      {
        id: "child-reply",
        content: "done MARKER-z",
        author: { id: "a", username: "⚙ claude", bot: true },
        webhook_id: "wh-1",
        timestamp: "2026-04-17T00:00:30Z",
      },
    ]);
    const msg = await assertVisibleInThread({
      threadId: "t",
      env,
      marker: "MARKER-z",
      timeoutMs: 10_000,
    });
    expect(msg.id).toBe("child-reply");
    expect((msg as { webhook_id?: string }).webhook_id).toBe("wh-1");
  });

  it("waits out initial user-only echo and returns webhook reply once it arrives", async () => {
    // First poll: only the user/bot echo is visible. Second poll: the webhook
    // reply has appeared. The helper must NOT return the user echo on poll 1;
    // it must keep polling and return the webhook reply on poll 2.
    let callCount = 0;
    restHandlers.get.mockImplementation(async () => {
      callCount += 1;
      const userEcho = {
        id: "user-echo",
        content: "task: MARKER-w please",
        author: { id: "u", username: "openclaw-e2e", bot: true },
        timestamp: "2026-04-17T00:00:01Z",
      };
      if (callCount === 1) {
        return [userEcho];
      }
      return [
        userEcho,
        {
          id: "child-reply",
          content: "MARKER-w done",
          author: { id: "a", username: "⚙ claude", bot: true },
          webhook_id: "wh-7",
          timestamp: "2026-04-17T00:00:30Z",
        },
      ];
    });
    const msg = await assertVisibleInThread({
      threadId: "t",
      env,
      marker: "MARKER-w",
      timeoutMs: 10_000,
    });
    expect(msg.id).toBe("child-reply");
    expect((msg as { webhook_id?: string }).webhook_id).toBe("wh-7");
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("throws when no matches appear before timeout", async () => {
    restHandlers.get.mockImplementation(async () => [
      {
        id: "m-other",
        content: "no marker here",
        author: { id: "u", username: "openclaw-e2e", bot: true },
        timestamp: "2026-04-17T00:00:00Z",
      },
    ]);
    await expect(
      assertVisibleInThread({
        threadId: "t",
        env,
        marker: "NEVER-SEEN",
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/not seen in thread/);
  });

  // --- Strict visibility semantics (Task 2) --------------------------------
  //
  // These tests prove the helper cannot be fooled into reporting success
  // when the only marker match is the harness request message itself.

  it("ignores the original request message when scanning for the marker", async () => {
    // The harness request message (request-id "req-1") is bot-authored and
    // contains the marker. A later webhook-authored reply also contains the
    // marker. With excludeMessageIds set to [request-id] the helper MUST
    // return the webhook reply, not the request.
    restHandlers.get.mockImplementation(async () => [
      {
        id: "req-1",
        content: "task: please echo MARKER-STRICT-A",
        author: { id: "u", username: "openclaw-e2e", bot: true },
        timestamp: "2026-04-17T00:00:00Z",
      },
      {
        id: "child-reply",
        content: "MARKER-STRICT-A done",
        author: { id: "a", username: "⚙ claude", bot: true },
        webhook_id: "wh-1",
        timestamp: "2026-04-17T00:00:30Z",
      },
    ]);
    const msg = await assertVisibleInThread({
      threadId: "t",
      env,
      marker: "MARKER-STRICT-A",
      timeoutMs: 2_000,
      excludeMessageIds: ["req-1"],
    });
    expect(msg.id).toBe("child-reply");
    expect((msg as { webhook_id?: string }).webhook_id).toBe("wh-1");
  });

  it("throws by default when only non-webhook marker matches exist", async () => {
    // Only a bot/user-authored marker match exists. Under the new strict
    // default (requireWebhookAuthor: true, allowDiagnosticFallback: false),
    // the helper MUST throw rather than silently falling back to the
    // non-webhook match.
    restHandlers.get.mockImplementation(async () => [
      {
        id: "req-1",
        content: "task message with MARKER-STRICT-B echoed",
        author: { id: "u", username: "openclaw-e2e", bot: true },
        timestamp: "2026-04-17T00:00:00Z",
      },
    ]);
    await expect(
      assertVisibleInThread({
        threadId: "t",
        env,
        marker: "MARKER-STRICT-B",
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/not seen in thread|no webhook-authored/i);
  });

  it("only allows non-webhook fallback in explicit diagnostic mode", async () => {
    // Same thread state as the previous test, but this time callers pass
    // allowDiagnosticFallback: true. The helper may now return the
    // non-webhook match so operators can triage "saw a match but not a
    // webhook one" vs "saw nothing at all".
    restHandlers.get.mockImplementation(async () => [
      {
        id: "req-1",
        content: "task message with MARKER-STRICT-C echoed",
        author: { id: "u", username: "openclaw-e2e", bot: true },
        timestamp: "2026-04-17T00:00:00Z",
      },
    ]);
    const msg = await assertVisibleInThread({
      threadId: "t",
      env,
      marker: "MARKER-STRICT-C",
      timeoutMs: 200,
      allowDiagnosticFallback: true,
    });
    expect(msg.id).toBe("req-1");
  });

  it("excludes request id even in diagnostic fallback mode", async () => {
    // Guard: excludeMessageIds must apply to both the webhook scan AND the
    // diagnostic fallback. A request-id echo of the marker must NEVER count
    // as visible proof, even when callers opt into the fallback.
    restHandlers.get.mockImplementation(async () => [
      {
        id: "req-1",
        content: "task message with MARKER-STRICT-D echoed",
        author: { id: "u", username: "openclaw-e2e", bot: true },
        timestamp: "2026-04-17T00:00:00Z",
      },
    ]);
    await expect(
      assertVisibleInThread({
        threadId: "t",
        env,
        marker: "MARKER-STRICT-D",
        timeoutMs: 200,
        excludeMessageIds: ["req-1"],
        allowDiagnosticFallback: true,
      }),
    ).rejects.toThrow(/not seen in thread|no webhook-authored/i);
  });

  it("requireWebhookAuthor:false permits non-webhook matches without fallback flag", async () => {
    // Some explicit-diagnostic callers do not care about authorship at
    // all. Setting requireWebhookAuthor:false must allow any match
    // (subject to excludeMessageIds) to satisfy the assertion immediately.
    restHandlers.get.mockImplementation(async () => [
      {
        id: "req-1",
        content: "task: MARKER-STRICT-E",
        author: { id: "u", username: "openclaw-e2e", bot: true },
        timestamp: "2026-04-17T00:00:00Z",
      },
      {
        id: "bot-reply",
        content: "MARKER-STRICT-E done",
        author: { id: "a", username: "⚙ claude", bot: true },
        timestamp: "2026-04-17T00:00:30Z",
      },
    ]);
    const msg = await assertVisibleInThread({
      threadId: "t",
      env,
      marker: "MARKER-STRICT-E",
      timeoutMs: 2_000,
      requireWebhookAuthor: false,
      excludeMessageIds: ["req-1"],
    });
    expect(msg.id).toBe("bot-reply");
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
