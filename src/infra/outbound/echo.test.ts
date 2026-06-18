import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { SessionEntry, SessionEchoTarget } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  registerChannelEchoAdmission,
  resetChannelEchoAdmissionForTest,
} from "./channel-admission.js";
import { resolveEchoTargets, fireEchoDeliveries, targetMatchesSessionParticipant } from "./echo.js";

vi.mock("./deliver.js", () => ({
  deliverOutboundPayloadsInternal: vi.fn(() => Promise.resolve()),
}));

import { deliverOutboundPayloadsInternal as _mockDeliver } from "./deliver.js";
const mockDeliver = vi.mocked(_mockDeliver);

function makeTarget(overrides?: Partial<SessionEchoTarget>): SessionEchoTarget {
  return {
    channel: "discord",
    to: "123",
    accountId: "bot1",
    threadId: "456",
    echoUser: true,
    echoAssistant: true,
    addedAt: 1700000000000,
    ...overrides,
  } as SessionEchoTarget;
}

function makeEntry(targets: SessionEchoTarget[]): SessionEntry {
  return { echoTargets: targets } as unknown as SessionEntry;
}

const fakeCfg = {} as OpenClawConfig;

describe("resolveEchoTargets", () => {
  const target = makeTarget();

  it("returns empty when entry has no echoTargets", () => {
    expect(
      resolveEchoTargets(undefined, { originChannel: "telegram", originTo: "x", role: "user" }),
    ).toEqual([]);
    expect(
      resolveEchoTargets({} as SessionEntry, {
        originChannel: "telegram",
        originTo: "x",
        role: "user",
      }),
    ).toEqual([]);
  });

  it("excludes the origin target (self-echo prevention)", () => {
    const result = resolveEchoTargets(makeEntry([target]), {
      originChannel: "discord",
      originTo: "123",
      originAccountId: "bot1",
      originThreadId: "456",
      role: "assistant",
    });
    expect(result).toEqual([]);
  });

  it("includes targets that differ by channel", () => {
    const result = resolveEchoTargets(makeEntry([target]), {
      originChannel: "telegram",
      originTo: "123",
      originAccountId: "bot1",
      originThreadId: "456",
      role: "assistant",
    });
    expect(result).toEqual([target]);
  });

  it("includes targets that differ only by accountId", () => {
    const result = resolveEchoTargets(makeEntry([target]), {
      originChannel: "discord",
      originTo: "123",
      originAccountId: "bot2",
      originThreadId: "456",
      role: "assistant",
    });
    expect(result).toEqual([target]);
  });

  it("treats defined accountId vs undefined as different (not self)", () => {
    const result = resolveEchoTargets(makeEntry([target]), {
      originChannel: "discord",
      originTo: "123",
      originThreadId: "456",
      role: "assistant",
    });
    expect(result).toEqual([target]);
  });

  it("self-excludes when target has no accountId but origin resolves one (unpinned target = wildcard)", () => {
    // Regression: a `sessions echo add` target without an accountId must still
    // self-exclude against a same channel+to+thread origin whose account got
    // resolved to a default (Telegram inbounds resolve accountId to "default").
    // The old `(!target.accountId && !originAccountId)` clause made undefined-vs-
    // "default" a mismatch, so a thread echoed to itself.
    const tgTarget = makeTarget({
      channel: "telegram",
      to: "999",
      accountId: undefined,
      threadId: "26237",
    });
    const result = resolveEchoTargets(makeEntry([tgTarget]), {
      originChannel: "telegram",
      originTo: "999",
      originAccountId: "default",
      originThreadId: "26237",
      role: "user",
    });
    expect(result).toEqual([]);
  });

  it("includes targets that differ by threadId", () => {
    const result = resolveEchoTargets(makeEntry([target]), {
      originChannel: "discord",
      originTo: "123",
      originAccountId: "bot1",
      originThreadId: "789",
      role: "assistant",
    });
    expect(result).toEqual([target]);
  });

  it("matches threadId via string coercion (number vs string)", () => {
    const result = resolveEchoTargets(
      makeEntry([makeTarget({ threadId: 456 as unknown as string })]),
      {
        originChannel: "discord",
        originTo: "123",
        originAccountId: "bot1",
        originThreadId: "456",
        role: "assistant",
      },
    );
    expect(result).toEqual([]);
  });

  it("treats both-undefined threadId as same (self-match)", () => {
    const noThread = makeTarget({ threadId: undefined });
    const result = resolveEchoTargets(makeEntry([noThread]), {
      originChannel: "discord",
      originTo: "123",
      originAccountId: "bot1",
      role: "assistant",
    });
    expect(result).toEqual([]);
  });

  it("filters by echoUser=false for user role", () => {
    const noUserEcho = makeTarget({ echoUser: false, channel: "slack", to: "C01" });
    const result = resolveEchoTargets(makeEntry([noUserEcho]), {
      originChannel: "telegram",
      originTo: "999",
      role: "user",
    });
    expect(result).toEqual([]);
  });

  it("filters by echoAssistant=false for assistant role", () => {
    const noAssistantEcho = makeTarget({ echoAssistant: false, channel: "slack", to: "C01" });
    const result = resolveEchoTargets(makeEntry([noAssistantEcho]), {
      originChannel: "telegram",
      originTo: "999",
      role: "assistant",
    });
    expect(result).toEqual([]);
  });

  it("includes target when echoUser/echoAssistant are undefined (default-include)", () => {
    const defaults = makeTarget({
      echoUser: undefined,
      echoAssistant: undefined,
      channel: "slack",
      to: "C01",
    });
    expect(
      resolveEchoTargets(makeEntry([defaults]), {
        originChannel: "telegram",
        originTo: "999",
        role: "user",
      }),
    ).toEqual([defaults]);
    expect(
      resolveEchoTargets(makeEntry([defaults]), {
        originChannel: "telegram",
        originTo: "999",
        role: "assistant",
      }),
    ).toEqual([defaults]);
  });

  it("returns multiple non-origin targets", () => {
    const t2 = makeTarget({ channel: "slack", to: "C01" });
    const result = resolveEchoTargets(makeEntry([target, t2]), {
      originChannel: "telegram",
      originTo: "999",
      role: "user",
    });
    expect(result).toHaveLength(2);
  });

  it("self-excludes when target.to is raw and origin uses telegram: prefix", () => {
    const tgTarget = makeTarget({
      channel: "telegram",
      to: "999",
      accountId: undefined,
      threadId: "26237",
    });
    const result = resolveEchoTargets(makeEntry([tgTarget]), {
      originChannel: "telegram",
      originTo: "telegram:999",
      originThreadId: "26237",
      role: "user",
    });
    expect(result).toEqual([]);
  });

  it("self-excludes when target.to uses telegram: prefix and origin is raw", () => {
    const tgTarget = makeTarget({
      channel: "telegram",
      to: "telegram:999",
      accountId: undefined,
      threadId: "26237",
    });
    const result = resolveEchoTargets(makeEntry([tgTarget]), {
      originChannel: "telegram",
      originTo: "999",
      originThreadId: "26237",
      role: "user",
    });
    expect(result).toEqual([]);
  });

  it("self-excludes with tg: prefix variant", () => {
    const tgTarget = makeTarget({
      channel: "telegram",
      to: "tg:999",
      accountId: undefined,
      threadId: undefined,
    });
    const result = resolveEchoTargets(makeEntry([tgTarget]), {
      originChannel: "telegram",
      originTo: "999",
      role: "assistant",
    });
    expect(result).toEqual([]);
  });

  it("self-excludes a forum-topic pinned target against the same chat+topic origin", () => {
    // The pinned target carries the forum topic in its `:topic:<n>` suffix, but
    // normalizeEchoTargetId strips it so the chat-id comparison is topic-agnostic.
    // The topic is then matched via threadId (7 === origin 7), so a target
    // `telegram:-100200300:topic:7` echoing back into the same chat+topic the
    // post-hoc message:sent path supplies (bare "-100200300", threadId 7) is
    // the same place and must self-exclude — otherwise it duplicates the echo.
    const topicTarget = makeTarget({
      channel: "telegram",
      to: "telegram:-100200300:topic:7",
      accountId: undefined,
      threadId: "7",
    });
    const bareOrigin = resolveEchoTargets(makeEntry([topicTarget]), {
      originChannel: "telegram",
      originTo: "-100200300",
      originThreadId: 7,
      role: "assistant",
    });
    expect(bareOrigin).toEqual([]);
    // Same self-exclusion when the origin keeps the telegram: prefix on the chat id.
    const prefixedOrigin = resolveEchoTargets(makeEntry([topicTarget]), {
      originChannel: "telegram",
      originTo: "telegram:-100200300",
      originThreadId: 7,
      role: "assistant",
    });
    expect(prefixedOrigin).toEqual([]);
  });

  it("does NOT exclude a forum-topic pinned target when the origin is a different topic", () => {
    // Stripping the `:topic:7` suffix only makes the chat-id comparison
    // topic-agnostic; threadId still distinguishes topics. The same pinned
    // target (topic 7) against an origin in a different topic (threadId 9) is a
    // distinct destination and must still be returned.
    const topicTarget = makeTarget({
      channel: "telegram",
      to: "telegram:-100200300:topic:7",
      accountId: undefined,
      threadId: "7",
    });
    const result = resolveEchoTargets(makeEntry([topicTarget]), {
      originChannel: "telegram",
      originTo: "-100200300",
      originThreadId: 9,
      role: "assistant",
    });
    expect(result).toEqual([topicTarget]);
  });
});

describe("fireEchoDeliveries", () => {
  afterEach(() => {
    mockDeliver.mockReset();
    mockDeliver.mockResolvedValue(undefined as never);
    resetChannelEchoAdmissionForTest();
  });

  it("suppresses echo delivery to a target whose channel reports it inadmissible (revocation)", async () => {
    // The channel-agnostic echo send bypasses the channel's own inbound admission
    // gate, so a disabled (revoked) destination would still receive echoes. The
    // admission predicate makes the echo path honor live enablement: fail closed.
    registerChannelEchoAdmission("test-owner", "telegram", "default", () => false);
    const entry = makeEntry([
      makeTarget({ channel: "telegram", to: "telegram:-100", accountId: "default", threadId: 1 }),
    ]);
    await fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "webchat",
        originTo: "",
        role: "user",
      },
      [{ text: "secret prompt" }],
    );
    // The disabled destination receives nothing — neither native mirror nor echo.
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it("delivers when the channel predicate admits the target", async () => {
    registerChannelEchoAdmission("test-owner", "telegram", "default", () => true);
    const entry = makeEntry([
      makeTarget({ channel: "telegram", to: "telegram:-100", accountId: "default", threadId: 1 }),
    ]);
    await fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "webchat",
        originTo: "",
        role: "user",
      },
      [{ text: "hi" }],
    );
    expect(mockDeliver).toHaveBeenCalledOnce();
  });

  it("never passes session or mirror to deliver (loop-safety contract)", async () => {
    const entry = makeEntry([makeTarget({ channel: "discord", to: "999" })]);
    await fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "telegram",
        originTo: "123",
        role: "assistant",
      },
      [{ text: "hello" }],
    );

    expect(mockDeliver).toHaveBeenCalledOnce();
    const callArgs = mockDeliver.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty("session");
    expect(callArgs).not.toHaveProperty("mirror");
    expect(Object.keys(callArgs)).toEqual(
      expect.arrayContaining([
        "cfg",
        "channel",
        "to",
        "payloads",
        "bestEffort",
        "skipQueue",
        "silent",
      ]),
    );
    expect(callArgs).toHaveProperty("bestEffort", true);
    expect(callArgs).toHaveProperty("silent", true);
  });

  it("delivers assistant echo natively (no prefix) when prefixed:false", async () => {
    // Production path: handleMessageSent passes { prefixed: false } so the response
    // mirrors to pinned channels as a native reply, not a marked "[echo]" message.
    const entry = makeEntry([makeTarget({ channel: "discord", to: "999" })]);
    await fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "telegram",
        originTo: "123",
        role: "assistant",
      },
      [{ text: "hello" }],
      { prefixed: false },
    );

    const callArgs = mockDeliver.mock.calls[0][0] as Record<string, unknown>;
    const payloads = callArgs.payloads as Array<{ text: string }>;
    expect(payloads[0].text).toBe("hello");
  });

  it("still prefixes assistant echo with [echo] when prefixed is not disabled", async () => {
    // Default API behavior (no options) keeps the legacy "[echo]" marker; only the
    // message:sent hook opts out via { prefixed: false }.
    const entry = makeEntry([makeTarget({ channel: "discord", to: "999" })]);
    await fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "telegram",
        originTo: "123",
        role: "assistant",
      },
      [{ text: "hello" }],
    );

    const callArgs = mockDeliver.mock.calls[0][0] as Record<string, unknown>;
    const payloads = callArgs.payloads as Array<{ text: string }>;
    expect(payloads[0].text).toMatch(/\[echo\] hello$/);
  });

  it("prefixes user echo payload with [via <channel>]", async () => {
    const entry = makeEntry([makeTarget({ channel: "discord", to: "999" })]);
    await fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "telegram",
        originTo: "123",
        role: "user",
      },
      [{ text: "hi there" }],
    );

    const callArgs = mockDeliver.mock.calls[0][0] as Record<string, unknown>;
    const payloads = callArgs.payloads as Array<{ text: string }>;
    expect(payloads[0].text).toMatch(/\[via telegram\] hi there$/);
  });

  it("prefixes text payloads and preserves non-text payloads in mixed array", async () => {
    const entry = makeEntry([makeTarget({ channel: "discord", to: "999" })]);
    const textPayload = { text: "hello" } as ReplyPayload;
    const mediaPayload = { media: "image.png" } as unknown as ReplyPayload;
    await fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "telegram",
        originTo: "123",
        role: "assistant",
      },
      [textPayload, mediaPayload],
    );

    const callArgs = mockDeliver.mock.calls[0][0] as Record<string, unknown>;
    const payloads = callArgs.payloads as Array<Record<string, unknown>>;
    expect(payloads).toHaveLength(2);
    expect((payloads[0] as { text: string }).text).toMatch(/\[echo\] hello$/);
    expect(payloads[1]).toEqual(mediaPayload);
  });

  it("delivers to each resolved target independently", async () => {
    const entry = makeEntry([
      makeTarget({ channel: "discord", to: "111" }),
      makeTarget({ channel: "slack", to: "222" }),
    ]);
    await fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "telegram",
        originTo: "999",
        role: "assistant",
      },
      [{ text: "hello" }],
    );

    expect(mockDeliver).toHaveBeenCalledTimes(2);
    const channels = mockDeliver.mock.calls.map((c) => (c[0] as Record<string, unknown>).channel);
    expect(channels).toContain("discord");
    expect(channels).toContain("slack");
  });

  it("does not deliver when all targets are self-excluded", async () => {
    const entry = makeEntry([makeTarget({ channel: "telegram", to: "123" })]);
    await fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "telegram",
        originTo: "123",
        originAccountId: "bot1",
        originThreadId: "456",
        role: "assistant",
      },
      [{ text: "hello" }],
    );

    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it("does not deliver when entry has no echo targets", async () => {
    const entry = makeEntry([]);
    await fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "telegram",
        originTo: "123",
        role: "assistant",
      },
      [{ text: "hello" }],
    );

    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it("swallows delivery errors without propagating", async () => {
    mockDeliver.mockRejectedValue(new Error("transport down"));
    const entry = makeEntry([makeTarget({ channel: "discord", to: "999" })]);

    await expect(
      fireEchoDeliveries(
        {
          cfg: fakeCfg,
          sessionKey: "agent:main",
          sessionEntry: entry,
          originChannel: "telegram",
          originTo: "123",
          role: "assistant",
        },
        [{ text: "hello" }],
      ),
    ).resolves.toBeUndefined();
  });
});

describe("targetMatchesSessionParticipant (no arbitrary chat ids)", () => {
  const boundEntry = {
    lastChannel: "telegram",
    lastTo: "12345",
    lastAccountId: "default",
    lastThreadId: "77",
  } as unknown as SessionEntry;

  it("accepts the session's own bound participant identity", async () => {
    expect(
      targetMatchesSessionParticipant(boundEntry, {
        channel: "telegram",
        to: "12345",
        accountId: "default",
        threadId: "77",
      }),
    ).toBe(true);
  });

  it("rejects a different channel / chat id / thread (arbitrary target)", async () => {
    expect(targetMatchesSessionParticipant(boundEntry, { channel: "discord", to: "999" })).toBe(
      false,
    );
    expect(
      targetMatchesSessionParticipant(boundEntry, {
        channel: "telegram",
        to: "99999",
        accountId: "default",
        threadId: "77",
      }),
    ).toBe(false);
    expect(
      targetMatchesSessionParticipant(boundEntry, {
        channel: "telegram",
        to: "12345",
        accountId: "default",
        threadId: "88",
      }),
    ).toBe(false);
  });

  it("fails closed when the session has no known participant", async () => {
    expect(
      targetMatchesSessionParticipant({} as SessionEntry, { channel: "telegram", to: "12345" }),
    ).toBe(false);
  });
});
