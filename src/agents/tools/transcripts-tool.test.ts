import assert from "node:assert/strict";
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
} from "../../transcripts/provider-types.js";
import { createTranscriptsTool } from "./transcripts-tool.js";
import {
  registerTranscriptTestProvider,
  useTranscriptTestState,
} from "./transcripts-tool.test-support.js";

type Start = NonNullable<TranscriptSourceProvider["start"]>;
type Stop = NonNullable<TranscriptSourceProvider["stop"]>;
const testState = useTranscriptTestState();
const config = { plugins: { allow: ["transcript-test-fixture"] }, transcripts: { enabled: true } };
const localCaller = { kind: "operator", source: "local" } as const;
const captureSource = { accountId: "account-a", guildId: "guild-a", channelId: "voice-a" };
const startCapture: Start = async ({ session }) => ({ ok: true, session });
const stopCapture: Stop = async ({ sessionId }) => ({ ok: true, sessionId });
const authorize: NonNullable<TranscriptSourceProvider["accessControl"]>["authorize"] = async ({
  caller,
  source,
}) =>
  caller.kind === "operator" ||
  (caller.channel === "discord" && caller.accountId === source.accountId)
    ? { ok: true, value: undefined }
    : { ok: false, error: "account denied" };
const expectDetails = (
  result: ReturnType<ReturnType<typeof createTranscriptsTool>["execute"]>,
  details: unknown,
) => expect(result).resolves.toMatchObject({ details });
const emptyStatus = { active: [] };
type Origin = { channel: string; accountId?: string };
const owner = { channel: "discord", accountId: "account-a" };
const remote = { channel: "webchat", accountId: "operator" };

function harness(
  overrides: Partial<TranscriptSourceProvider> = {},
  accountBound = false,
  defaultConfig = false,
) {
  const { stateDir, store } = testState();
  const start = vi.fn(startCapture);
  const stop = vi.fn(stopCapture);
  const resolveAccountId = vi.fn<
    NonNullable<TranscriptSourceProvider["accessControl"]>["resolveAccountId"]
  >(({ source }) => ({ ok: true, value: source.accountId }));
  const provider: TranscriptSourceProvider = {
    id: accountBound ? "discord-voice" : "proof-live",
    name: accountBound ? "Discord Voice" : "Proof Live",
    sourceKinds: [accountBound ? "live-audio" : "live-caption"],
    start,
    stop,
    accessControl: accountBound ? { channelId: "discord", resolveAccountId, authorize } : undefined,
    ...overrides,
  };
  registerTranscriptTestProvider(provider, defaultConfig ? provider.id : "transcript-test-fixture");
  const ctx = {
    config: defaultConfig ? undefined : config,
    stateDir,
    logger: { warn: vi.fn() },
    caller: localCaller,
  };
  const execute = (
    params: Record<string, unknown>,
    origin?: Origin,
    agentId = accountBound ? "main" : undefined,
    signal?: AbortSignal,
  ) =>
    createTranscriptsTool({
      ...ctx,
      agentId,
      caller: origin
        ? { kind: "channel", ...origin, senderId: "test-sender", roleIds: [] }
        : localCaller,
    }).execute("test", params, signal);
  const action = (name: string, sessionId?: string) => execute({ action: name, sessionId });
  const begin = (signal?: AbortSignal) =>
    execute(
      { action: "start", providerId: provider.id, sessionId: "notes" },
      undefined,
      undefined,
      signal,
    );
  const capture = (sessionId: string, origin?: Origin, agentId = "main", source = {}) =>
    execute(
      { action: "start", providerId: provider.id, ...captureSource, sessionId, ...source },
      origin,
      agentId,
    );
  const historical = async (
    sessionId: string,
    day: string,
    metadata?: TranscriptSessionDescriptor["metadata"],
    accountId: string | null = "account-a",
  ) => {
    const session = {
      sessionId,
      source: { providerId: provider.id, ...(accountId === null ? {} : { accountId }) },
      startedAt: `2026-${day}T12:00:00.000Z`,
      stoppedAt: `2026-${day}T12:05:00.000Z`,
      metadata,
    };
    await store.writeSession(session);
    await store.appendUtteranceForSession(session, { text: "shipped notes" });
  };
  const access = async (sessionId: string, allowed: boolean, origin?: Origin, agentId = "main") => {
    const result = execute({ action: "summarize", sessionId }, origin, agentId);
    if (allowed) {
      await expectDetails(result, { sessionId });
    } else {
      await expect(result).rejects.toThrow(`transcripts session not found: ${sessionId}`);
    }
  };
  return {
    ...ctx,
    provider,
    execute,
    action,
    begin,
    start,
    stop,
    resolveAccountId,
    capture,
    historical,
    access,
    store,
  };
}

describe("transcripts tool", () => {
  it("keeps capturing after the initiating agent run ends", async () => {
    const controller = new AbortController();
    const h = harness();
    await h.begin(controller.signal);
    const request = h.start.mock.calls[0]?.[0];
    assert(request);
    expect(request.abortSignal).not.toBe(controller.signal);
    controller.abort();
    expect(request.abortSignal?.aborted).toBe(false);
    const text = "captured after the start action completed\nsecond\tcolumn";
    await request.onUtterance({ text, final: true });
    const session = await h.store.readSession("notes");
    assert(session);
    await expect(h.store.readUtterancesForSession(session)).resolves.toEqual([
      expect.objectContaining({ text }),
    ]);
    await h.action("stop", "notes");
    await expect(
      fs.readFile(path.join(h.store.sessionDir(session), "summary.md"), "utf8"),
    ).resolves.toContain("captured after the start action completed\\nsecond\\tcolumn");
  });

  it.each(["start", "stop"] as const)("reserves a session while %s is pending", async (phase) => {
    const entered = createDeferred();
    const release = createDeferred();
    const wait = async () => {
      entered.resolve();
      await release.promise;
    };
    const h = harness();
    if (phase === "start") {
      h.start.mockImplementation(async (request) => {
        await wait();
        return startCapture(request);
      });
    } else {
      h.stop.mockImplementation(async (request) => {
        await wait();
        return stopCapture(request);
      });
      await h.begin();
    }
    const pending = phase === "start" ? h.begin() : h.action("stop", "notes");
    await entered.promise;
    try {
      if (phase === "start") {
        await expect(h.begin()).rejects.toThrow("transcripts session already active: notes");
      }
      await expectDetails(h.action("stop", "notes"), { sessionId: "notes", skipped: true });
      expect(h.stop).toHaveBeenCalledTimes(phase === "start" ? 0 : 1);
      if (phase === "stop") {
        await expect(h.begin()).rejects.toThrow("transcripts session already active: notes");
      }
    } finally {
      release.resolve();
      await pending;
      if (phase === "start") {
        await h.action("stop", "notes");
      }
    }
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.stop).toHaveBeenCalledOnce();
    if (phase === "stop") {
      const replacement = harness();
      await replacement.begin();
      await expectDetails(replacement.action("status"), {
        active: [expect.objectContaining({ sessionId: "notes" })],
      });
      await replacement.action("stop", "notes");
    }
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
    await expect(h.begin(controller.signal)).rejects.toThrow(
      `transcripts start aborted; provider cleanup failed: ${error}`,
    );
    await expect(h.action("stop", "notes")).rejects.toThrow(
      `transcripts provider cleanup failed: ${error}`,
    );
    const stop = vi.fn(stopCapture);
    h.provider.stop = stop;
    await h.action("stop", "notes");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("rejects configured auto-start when provider resolution removes the account", async () => {
    const h = harness({
      accessControl: {
        channelId: "discord",
        resolveAccountId: () => ({ ok: true, value: undefined }),
        authorize,
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
    expect(h.start).not.toHaveBeenCalled();
    await expect(h.store.readSession("notes")).resolves.toBeUndefined();
  });

  it.each([
    { limit: "entry count", idChars: 24, count: 8, shown: 5 },
    { limit: "oversized source locator", idChars: 2_200, count: 1, shown: 1 },
  ])(
    "bounds status by $limit without clipping canonical selectors",
    async ({ idChars, count, shown }) => {
      const h = harness(
        {
          id: "room-audio",
          name: "Room Audio",
          sourceKinds: ["live-audio"],
        },
        false,
        true,
      );
      const sessionIds = [
        ...Array.from({ length: count }, (_, index) => `notes-${index}-${"?".repeat(idChars)}`),
        "readable-tail",
      ];
      const startedSessionIds: string[] = [];
      const selectors: string[] = [];
      try {
        for (const sessionId of sessionIds) {
          const result = await h.execute({
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
        const result = await h.action("status");
        const text = result.content.find((item) => item.type === "text")?.text ?? "";
        const listing = text.split("\n").slice(2).join("\n");
        const rows = listing.split("\n").filter((line) => line.startsWith("{"));
        const shownSelectors = rows.map((row) => JSON.parse(row).selector);
        expect(listing.length).toBeLessThanOrEqual(2_000);
        expect(rows).toHaveLength(shown);
        expect(listing).toContain("active sessions omitted (display limit)");
        expect(selectors).toEqual(expect.arrayContaining(shownSelectors));
        if (idChars > 24) {
          expect(shownSelectors).toContain(selectors.at(-1));
        }
        expect(result.details).toMatchObject({
          active: sessionIds.map((sessionId) => expect.objectContaining({ sessionId })),
        });
      } finally {
        for (const sessionId of startedSessionIds) {
          await h.action("stop", sessionId);
        }
      }
    },
  );
});

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
    const h = harness(
      { id: "account-bound-import", sourceKinds: ["posthoc-transcript"], importTranscript },
      true,
    );
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
    const h = harness({}, true);
    const result = await h.capture("account-bound", owner, "main", {
      accountId: "account-b",
      guildId: "guild-b",
      channelId: "channel-b",
    });
    expect(h.start.mock.calls[0]?.[0].session.source.accountId).toBe("account-a");
    expect(h.resolveAccountId.mock.calls[0]?.[0].source.accountId).toBe("account-a");
    expect(await h.store.readSession("account-bound")).toMatchObject({
      source: { accountId: "account-a" },
      metadata: { agentId: "main" },
    });
    expect(result.details).toMatchObject({ accountId: "account-a" });
    const otherAccount = { ...owner, accountId: "account-b" };
    for (const origin of [otherAccount, { ...owner, channel: "slack" }, remote]) {
      await expectDetails(h.execute({ action: "status" }, origin), emptyStatus);
    }
    await expect(
      h.execute({ action: "stop", sessionId: "account-bound" }, otherAccount),
    ).rejects.toThrow("transcripts session not found: account-bound");
    expect(h.stop).not.toHaveBeenCalled();
    setActivePluginRegistry(createEmptyPluginRegistry());
    for (const origin of [remote, owner]) {
      await expectDetails(h.execute({ action: "status" }, origin), emptyStatus);
    }
    await expectDetails(h.execute({ action: "status" }), {
      active: [expect.objectContaining({ sessionId: "account-bound" })],
    });
    await h.historical("owner-only", "08-03", {
      ownerChannel: "discord",
      ownerAccountId: "account-a",
    });
    await h.access("owner-only", false, remote, "research");
    await h.access("owner-only", true);
  });

  it("rejects provider redirection away from the trusted account before persistence", async () => {
    const h = harness({}, true);
    h.resolveAccountId.mockImplementation(({ source }) => {
      expect(source.accountId).toBe("account-a");
      return { ok: true, value: "account-b" };
    });
    await expect(
      h.capture("invalid-owner", owner, "main", { accountId: "account-b" }),
    ).rejects.toThrow(
      'transcripts provider discord-voice could not use trusted account "account-a"',
    );
    expect(h.resolveAccountId).toHaveBeenCalledOnce();
    expect(h.start).not.toHaveBeenCalled();
    expect(await h.store.readSession("invalid-owner")).toBeUndefined();
  });

  it("starts account-bound providers only from a binding channel or local tool", async () => {
    const h = harness({}, true);
    const start = h.capture;
    await expect(start("webchat-start", remote)).rejects.toThrow(
      "transcripts provider discord-voice can only start from discord or a channel-less local tool",
    );
    await expect(start("missing-account", { channel: "discord" })).rejects.toThrow(
      "transcripts provider discord-voice requires trusted account context from discord",
    );
    await expectDetails(start("unchanneled-non-main", undefined, "research"), {
      sessionId: "unchanneled-non-main",
    });
    await expectDetails(start("local-start"), { sessionId: "local-start" });
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(await h.store.readSession("webchat-start")).toBeUndefined();
  });

  it("does not treat provider lookup aliases as account binding channels", async () => {
    const h = harness(
      {
        id: "teams",
        aliases: ["msteams"],
        name: "Teams Meetings",
        sourceKinds: ["live-caption"],
        accessControl: undefined,
      },
      true,
    );
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
    const h = harness({}, true);
    await h.historical("stable-ownerless", "07-01");
    await h.historical("beta-agent-only", "07-02", { agentId: "main" });
    await h.historical("beta-named-agent", "07-03", { agentId: "research" });
    await h.historical("beta-accountless", "07-04", { agentId: "main" }, null);
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
