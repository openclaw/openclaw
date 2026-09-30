import { describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptSourceProvider,
} from "../../transcripts/provider-types.js";
import { createTranscriptsTool } from "./transcripts-tool.js";
import {
  registerTranscriptTestProvider,
  useTranscriptTestState,
} from "./transcripts-tool.test-support.js";

const testState = useTranscriptTestState();
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
      agentChannel: origin?.channel,
      agentAccountId: origin?.accountId,
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
  it("binds account-bound imports to the trusted turn account", async () => {
    const importTranscript = vi.fn<NonNullable<TranscriptSourceProvider["importTranscript"]>>(
      async () => [{ text: "trusted import" }],
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
        sessionId: "account-bound-import",
        transcript: "trusted import",
      },
      owner,
    );
    expect(h.resolveAccountId.mock.calls[0]?.[0].source.accountId).toBe("account-a");
    expect(importTranscript.mock.calls[0]?.[0].session.source.accountId).toBe("account-a");
    expect(await h.store.readSession("account-bound-import")).toMatchObject({
      source: { accountId: "account-a" },
      metadata: { agentId: "main" },
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

  it("preserves main-agent access to ownerless non-binding sessions", async () => {
    const h = fixture();
    await h.save({
      sessionId: "legacy-ownerless",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-07-01T12:00:00.000Z",
      stoppedAt: "2026-07-01T12:05:00.000Z",
    });
    await h.access("legacy-ownerless", true);
    await h.access("legacy-ownerless", true, remote);
    await h.access("legacy-ownerless", false, undefined, "research");
  });
});
