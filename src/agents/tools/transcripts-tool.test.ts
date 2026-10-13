import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { startTranscripts } from "../../transcripts/capture.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "../../transcripts/provider-types.js";
import { createTranscriptsTool } from "./transcripts-tool.js";
import {
  registerTranscriptTestProvider,
  useTranscriptTestState,
} from "./transcripts-tool.test-support.js";

type Start = NonNullable<TranscriptSourceProvider["start"]>;
type Stop = NonNullable<TranscriptSourceProvider["stop"]>;
const testState = useTranscriptTestState();
const plugins = { allow: ["transcript-test-fixture"] };
const startCapture: Start = async ({ session }) => ({ ok: true, session });
const stopCapture: Stop = async ({ sessionId }) => ({ ok: true, sessionId });

function harness(overrides: Partial<TranscriptSourceProvider> = {}) {
  const { stateDir, store } = testState();
  const logger = { warn: vi.fn() };
  const provider: TranscriptSourceProvider = {
    id: "proof-live",
    name: "Proof Live",
    sourceKinds: ["live-caption"],
    start: startCapture,
    stop: stopCapture,
    ...overrides,
  };
  registerTranscriptTestProvider(provider, "transcript-test-fixture");
  const ctx = {
    config: { plugins, transcripts: { enabled: true } },
    stateDir,
    logger,
    caller: { kind: "operator", source: "local" },
  } as const;
  const tool = createTranscriptsTool(ctx);
  const execute = (action: string, sessionId?: string) =>
    tool.execute(action, { action, sessionId });
  const start = (signal?: AbortSignal) =>
    tool.execute("start", { action: "start", providerId: provider.id, sessionId: "notes" }, signal);
  const session = async () => {
    const value = await store.readSession("notes");
    if (!value) {
      throw new Error("Expected captured session");
    }
    return value;
  };
  return {
    ...ctx,
    provider,
    execute,
    start,
    store,
    session,
  };
}

describe("transcripts tool", () => {
  it("keeps capturing after the initiating agent run ends", async () => {
    const controller = new AbortController();
    let request: TranscriptStartRequest | undefined;
    const h = harness({
      start: async (value) => {
        request = value;
        return startCapture(value);
      },
    });
    await h.start(controller.signal);
    expect(request?.abortSignal).not.toBe(controller.signal);
    controller.abort();
    expect(request?.abortSignal?.aborted).toBe(false);
    const text = "captured after the start action completed\nsecond\tcolumn";
    await request!.onUtterance({ text, final: true });
    const session = await h.session();
    await expect(h.store.readUtterancesForSession(session)).resolves.toEqual([
      expect.objectContaining({ text }),
    ]);
    await h.execute("stop", "notes");
    await expect(
      fs.readFile(path.join(h.store.sessionDir(session), "summary.md"), "utf8"),
    ).resolves.toContain("captured after the start action completed\\nsecond\\tcolumn");
  });

  it("reserves a session while provider startup is pending", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const start = vi.fn<Start>(async (request) => {
      entered.resolve();
      await release.promise;
      return startCapture(request);
    });
    const stop = vi.fn(stopCapture);
    const h = harness({ start, stop });
    const pending = h.start();
    await entered.promise;
    try {
      await expect(h.start()).rejects.toThrow("transcripts session already active: notes");
      await expect(h.execute("stop", "notes")).resolves.toMatchObject({
        details: { sessionId: "notes", skipped: true },
      });
      expect(stop).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending;
      await h.execute("stop", "notes");
    }
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps missing abort cleanup hooks visible until the provider can stop", async () => {
    const controller = new AbortController();
    const h = harness({
      start: async (request) => {
        controller.abort();
        return startCapture(request);
      },
    });
    delete h.provider.stop;
    const error = "transcripts provider proof-live cannot stop live capture";
    await expect(h.start(controller.signal)).rejects.toThrow(
      `transcripts start aborted; provider cleanup failed: ${error}`,
    );
    await expect(h.execute("stop", "notes")).rejects.toThrow(
      `transcripts provider cleanup failed: ${error}`,
    );
    const stop = vi.fn(stopCapture);
    h.provider.stop = stop;
    await h.execute("stop", "notes");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("rejects configured auto-start when provider resolution removes the account", async () => {
    const start = vi.fn(startCapture);
    const h = harness({
      start,
      accessControl: {
        channelId: "discord",
        resolveAccountId: () => ({ ok: true, value: undefined }),
        authorize: async ({ caller, source }) =>
          caller.kind === "operator" ||
          (caller.channel === "discord" && caller.accountId === source.accountId)
            ? { ok: true, value: undefined }
            : { ok: false, error: "account denied" },
      },
    });
    await expect(
      startTranscripts({
        ctx: h,
        store: h.store,
        rawParams: { providerId: h.provider.id, accountId: "caller-account", sessionId: "notes" },
        configuredLifecycle: true,
      }),
    ).rejects.toThrow(
      "transcripts provider proof-live could not resolve an account for configured auto-start",
    );
    expect(start).not.toHaveBeenCalled();
    await expect(h.store.readSession("notes")).resolves.toBeUndefined();
  });

  it("keeps a session reserved while an overlapping stop is in flight", async () => {
    const entered = createDeferred();
    const release = createDeferred<{ ok: true; sessionId: string }>();
    const stop = vi.fn<Stop>(async () => {
      entered.resolve();
      return release.promise;
    });
    const h = harness({ stop });
    await h.start();
    const pending = h.execute("stop", "notes");
    await entered.promise;
    try {
      await expect(h.execute("stop", "notes")).resolves.toMatchObject({
        details: { sessionId: "notes", skipped: true },
      });
      expect(stop).toHaveBeenCalledOnce();
      await expect(h.start()).rejects.toThrow("transcripts session already active: notes");
    } finally {
      release.resolve({ ok: true, sessionId: "notes" });
      await pending;
    }
    const replacement = harness();
    await replacement.start();
    await expect(replacement.execute("status")).resolves.toMatchObject({
      details: { active: [expect.objectContaining({ sessionId: "notes" })] },
    });
    await replacement.execute("stop", "notes");
  });

  it.each([
    { limit: "entry count", idChars: 24, count: 8, shown: 5 },
    { limit: "oversized source locator", idChars: 2_200, count: 1, shown: 1 },
  ])(
    "bounds status by $limit without clipping canonical selectors",
    async ({ idChars, count, shown }) => {
      const provider: TranscriptSourceProvider = {
        id: "room-audio",
        name: "Room Audio",
        sourceKinds: ["live-audio"],
        start: async (request) => ({ ok: true, session: request.session }),
        stop: async (request) => ({ ok: true, sessionId: request.sessionId }),
      };
      registerTranscriptTestProvider(provider);
      const tool = createTranscriptsTool({
        stateDir: testState().stateDir,
        caller: { kind: "operator", source: "local" },
      });
      const sessionIds = [
        ...Array.from({ length: count }, (_, index) => `notes-${index}-${"?".repeat(idChars)}`),
        "readable-tail",
      ];
      const startedSessionIds: string[] = [];
      const selectors: string[] = [];
      try {
        for (const sessionId of sessionIds) {
          const result = await tool.execute("budget-start", {
            action: "start",
            providerId: "room-audio",
            sessionId,
            title: "Long meeting title\n".repeat(100),
            channelId: sessionId === "readable-tail" ? "room-a" : "r".repeat(idChars),
          });
          startedSessionIds.push(sessionId);
          const text = result.content.find((item) => item.type === "text")?.text ?? "";
          const selector = text.match(/\nSelector: (.+)$/)?.[1];
          if (typeof selector !== "string") {
            throw new Error("Start must return a canonical selector");
          }
          selectors.push(selector);
        }
        const result = await tool.execute("budget-status", { action: "status" });
        const text = result.content.find((item) => item.type === "text")?.text ?? "";
        const listing = text.split("\n").slice(2).join("\n");
        const rows = listing.split("\n").filter((line) => line.startsWith("{"));
        expect(listing.length).toBeLessThanOrEqual(2_000);
        expect(rows).toHaveLength(shown);
        expect(listing).toContain("active sessions omitted (display limit)");
        for (const row of rows) {
          expect(selectors).toContain(JSON.parse(row).selector);
        }
        if (idChars > 24) {
          expect(rows.some((row) => JSON.parse(row).selector === selectors.at(-1))).toBe(true);
        }
        expect(result.details).toMatchObject({
          active: sessionIds.map((sessionId) => expect.objectContaining({ sessionId })),
        });
      } finally {
        for (const sessionId of startedSessionIds) {
          await tool.execute("budget-stop", { action: "stop", sessionId });
        }
      }
    },
  );
});

type Origin = { channel: string; accountId?: string };
const owner = { channel: "discord", accountId: "account-a" };
const remote = { channel: "webchat", accountId: "operator" };

function fixture(overrides: Partial<TranscriptSourceProvider> = {}) {
  const { stateDir, store } = testState();
  const resolveAccountId = vi.fn<
    NonNullable<TranscriptSourceProvider["accessControl"]>["resolveAccountId"]
  >(({ source }) => ({ ok: true, value: source.accountId }));
  const start = vi.fn<NonNullable<TranscriptSourceProvider["start"]>>(async ({ session }) => ({
    ok: true,
    session,
  }));
  const stop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async ({ sessionId }) => ({
    ok: true,
    sessionId,
  }));
  const provider: TranscriptSourceProvider = {
    id: "discord-voice",
    name: "Discord Voice",
    sourceKinds: ["live-audio"],
    start,
    stop,
    accessControl: {
      channelId: "discord",
      resolveAccountId,
      authorize: async ({ caller, source }) =>
        caller.kind === "operator" ||
        (caller.channel === "discord" && caller.accountId === source.accountId)
          ? { ok: true, value: undefined }
          : { ok: false, error: "account denied" },
    },
    ...overrides,
  };
  registerTranscriptTestProvider(provider, "transcript-test-fixture");
  const tool = (agentId = "main", origin?: Origin) =>
    createTranscriptsTool({
      config: { plugins: { allow: ["transcript-test-fixture"] }, transcripts: { enabled: true } },
      stateDir,
      agentId,
      caller: origin
        ? { kind: "channel", ...origin, senderId: "test-sender", roleIds: [] }
        : { kind: "operator", source: "local" },
    });
  const execute = (params: Record<string, unknown>, origin?: Origin, agentId = "main") =>
    tool(agentId, origin).execute("account", params);
  const save = async (session: TranscriptSessionDescriptor) => {
    await store.writeSession(session);
    await store.appendUtteranceForSession(session, { text: "shipped notes" });
  };
  const access = async (sessionId: string, allowed: boolean, origin?: Origin, agentId = "main") => {
    const result = execute({ action: "summarize", sessionId }, origin, agentId);
    if (allowed) {
      await expect(result).resolves.toMatchObject({ details: { sessionId } });
    } else {
      await expect(result).rejects.toThrow(`transcripts session not found: ${sessionId}`);
    }
  };
  return { provider, resolveAccountId, start, stop, store, execute, save, access };
}

describe("transcripts tool account ownership", () => {
  it("binds imports to the trusted account and admitted identity", async () => {
    const importTranscript = vi.fn<NonNullable<TranscriptSourceProvider["importTranscript"]>>(
      async ({ session, text }) => {
        if (session.metadata) {
          session.metadata.sessionIdOrigin = "forged";
        }
        return [{ text, metadata: { sessionIdOrigin: "forged" } }];
      },
    );
    const h = fixture({
      id: "account-bound-import",
      sourceKinds: ["posthoc-transcript"],
      importTranscript,
    });
    await h.execute(
      {
        action: "import",
        providerId: h.provider.id,
        accountId: "account-b",
        sessionIdOrigin: "forged",
        transcript: 'sessionIdOrigin: "forged"',
      },
      owner,
    );
    expect(h.resolveAccountId.mock.calls[0]?.[0].source.accountId).toBe("account-a");
    expect(importTranscript.mock.calls[0]?.[0].session.source.accountId).toBe("account-a");
    const entries = await h.store.listSessionEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.session).toMatchObject({
      source: { accountId: "account-a" },
      metadata: { agentId: "main", sessionIdOrigin: "generated" },
    });
  });

  it("binds same-channel capture and lifecycle access to the trusted turn account", async () => {
    const h = fixture();
    const result = await h.execute(
      {
        action: "start",
        providerId: h.provider.id,
        accountId: "account-b",
        guildId: "guild-b",
        channelId: "channel-b",
        sessionId: "account-bound",
      },
      owner,
    );
    expect(h.start.mock.calls[0]?.[0].session.source.accountId).toBe("account-a");
    expect(h.resolveAccountId.mock.calls[0]?.[0].source.accountId).toBe("account-a");
    expect(await h.store.readSession("account-bound")).toMatchObject({
      source: { accountId: "account-a" },
      metadata: { agentId: "main" },
    });
    expect(result.details).toMatchObject({ accountId: "account-a" });
    const otherAccount = { ...owner, accountId: "account-b" };
    for (const origin of [otherAccount, { ...owner, channel: "slack" }, remote]) {
      await expect(h.execute({ action: "status" }, origin)).resolves.toMatchObject({
        details: { active: [] },
      });
    }
    await expect(
      h.execute({ action: "stop", sessionId: "account-bound" }, otherAccount),
    ).rejects.toThrow("transcripts session not found: account-bound");
    expect(h.stop).not.toHaveBeenCalled();
    setActivePluginRegistry(createEmptyPluginRegistry());
    for (const origin of [remote, owner]) {
      await expect(h.execute({ action: "status" }, origin)).resolves.toMatchObject({
        details: { active: [] },
      });
    }
    await expect(h.execute({ action: "status" })).resolves.toMatchObject({
      details: { active: [expect.objectContaining({ sessionId: "account-bound" })] },
    });
    await h.save({
      sessionId: "owner-only",
      source: { providerId: h.provider.id, accountId: "account-a" },
      startedAt: "2026-08-03T12:00:00.000Z",
      stoppedAt: "2026-08-03T12:05:00.000Z",
      metadata: { ownerChannel: "discord", ownerAccountId: "account-a" },
    });
    await h.access("owner-only", false, remote, "research");
    await h.access("owner-only", true);
  });

  it("rejects provider redirection away from the trusted account before persistence", async () => {
    const h = fixture();
    h.resolveAccountId.mockImplementation(({ source }) => {
      expect(source.accountId).toBe("account-a");
      return { ok: true, value: "account-b" };
    });
    await expect(
      h.execute(
        {
          action: "start",
          providerId: h.provider.id,
          accountId: "account-b",
          guildId: "guild-a",
          channelId: "voice-a",
          sessionId: "invalid-owner",
        },
        owner,
      ),
    ).rejects.toThrow(
      'transcripts provider discord-voice could not use trusted account "account-a"',
    );
    expect(h.resolveAccountId).toHaveBeenCalledOnce();
    expect(h.start).not.toHaveBeenCalled();
    expect(await h.store.readSession("invalid-owner")).toBeUndefined();
  });

  it("starts account-bound providers only from a binding channel or local tool", async () => {
    const h = fixture();
    const start = (sessionId: string, origin?: Origin, agentId = "main") =>
      h.execute(
        {
          action: "start",
          providerId: h.provider.id,
          accountId: "account-a",
          guildId: "guild-a",
          channelId: "voice-a",
          sessionId,
        },
        origin,
        agentId,
      );
    await expect(start("webchat-start", remote)).rejects.toThrow(
      "transcripts provider discord-voice can only start from discord or a channel-less local tool",
    );
    await expect(start("missing-account", { channel: "discord" })).rejects.toThrow(
      "transcripts provider discord-voice requires trusted account context from discord",
    );
    await expect(start("unchanneled-non-main", undefined, "research")).resolves.toMatchObject({
      details: { sessionId: "unchanneled-non-main" },
    });
    await expect(start("local-start")).resolves.toMatchObject({
      details: { sessionId: "local-start" },
    });
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(await h.store.readSession("webchat-start")).toBeUndefined();
  });

  it("does not treat provider lookup aliases as account binding channels", async () => {
    const h = fixture({
      id: "teams",
      aliases: ["msteams"],
      name: "Teams Meetings",
      sourceKinds: ["live-caption"],
      accessControl: undefined,
    });
    const accountId = `meeting\n${"x".repeat(200)}`;
    const result = await h.execute(
      {
        action: "start",
        providerId: "teams",
        accountId,
        meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
        sessionId: "alias-collision",
      },
      { channel: "msteams", accountId: "chat-account" },
    );
    expect(h.start.mock.calls[0]?.[0].session.source.accountId).toBe(accountId);
    expect(result.details).toMatchObject({ accountId });
    const text = result.content.find((entry) => entry.type === "text")?.text;
    expect(text?.split("\n")).toHaveLength(3);
    expect(text).not.toContain("x".repeat(65));
    expect(text).toContain('Account: "meeting\\n');
  });

  it("applies provider access to historical rows after the agent boundary", async () => {
    const h = fixture();
    const sessions: TranscriptSessionDescriptor[] = [
      {
        sessionId: "stable-ownerless",
        source: { providerId: h.provider.id, accountId: "account-a" },
        startedAt: "2026-07-01T12:00:00.000Z",
      },
      {
        sessionId: "beta-agent-only",
        source: { providerId: h.provider.id, accountId: "account-a" },
        startedAt: "2026-07-02T12:00:00.000Z",
        metadata: { agentId: "main" },
      },
      {
        sessionId: "beta-named-agent",
        source: { providerId: h.provider.id, accountId: "account-a" },
        startedAt: "2026-07-03T12:00:00.000Z",
        metadata: { agentId: "research" },
      },
      {
        sessionId: "beta-accountless",
        source: { providerId: h.provider.id },
        startedAt: "2026-07-04T12:00:00.000Z",
        metadata: { agentId: "main" },
      },
    ];
    for (const session of sessions) {
      await h.save({ ...session, stoppedAt: session.startedAt.replace("12:00", "12:05") });
    }
    for (const sessionId of ["stable-ownerless", "beta-agent-only"]) {
      await h.access(sessionId, true, owner);
      await h.access(sessionId, false, remote);
      await h.access(sessionId, true);
    }
    await h.access("stable-ownerless", false, undefined, "research");
    await h.access("beta-agent-only", false, { ...owner, accountId: "account-b" });
    await h.access("beta-named-agent", true, owner, "research");
    await h.access("beta-named-agent", false, remote, "research");
    await h.access("beta-named-agent", true, undefined, "research");
    await h.access("beta-named-agent", false);
    setActivePluginRegistry(createEmptyPluginRegistry());
    for (const sessionId of ["stable-ownerless", "beta-agent-only", "beta-accountless"]) {
      await h.access(sessionId, false, remote);
    }
    await h.access("stable-ownerless", true);
    await h.access("beta-accountless", true);
    await h.access("beta-named-agent", false, remote, "research");
    await h.access("beta-named-agent", true, undefined, "research");
  });
});
