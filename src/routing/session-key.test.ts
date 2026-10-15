import { describe, expect, it, vi } from "vitest";

vi.unmock("./session-key.js");
import { resolveSessionStoreKey } from "../gateway/session-store-key.js";
import {
  parseCronRunScopeSuffix,
  parseThreadSessionSuffix,
} from "../sessions/session-key-utils.js";
import {
  agentSessionKeysMatchByRequestKey,
  buildAgentPeerSessionKey,
  buildGroupHistoryKey,
  classifySessionKeyShape,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  resolveEventSessionKey,
  isUnscopedSessionKeySentinel,
  scopeLegacySessionKeyToAgent,
  toAgentStoreSessionKey,
} from "./session-key.js";

describe("agent id session-key boundary", () => {
  it("keeps legacy keys absent at parse time and resolves them only with a configured default", () => {
    expect(parseAgentSessionKey("main")?.agentId).toBeUndefined();
    expect(() => resolveAgentIdFromSessionKey("main")).toThrow("configured default agent");
    expect(() => resolveAgentIdFromSessionKey("main", "   ")).toThrow("configured default agent");
    expect(resolveAgentIdFromSessionKey("main", "primary")).toBe("primary");
    expect(resolveAgentIdFromSessionKey("agent:worker:main", "primary")).toBe("worker");
    expect(() => resolveAgentIdFromSessionKey("agent::secret", "primary")).toThrow(
      "Malformed agent session key",
    );
  });
});

describe("classifySessionKeyShape", () => {
  it.each([{ input: undefined, expected: "missing" }] as const)(
    "classifies %j as $expected",
    ({ input, expected }) => {
      expect(classifySessionKeyShape(input)).toBe(expected);
    },
  );
});

describe("scopeLegacySessionKeyToAgent", () => {
  it("scopes legacy aliases to the requested agent", () => {
    expect(scopeLegacySessionKeyToAgent({ agentId: "Ops", sessionKey: "Incident-42" })).toBe(
      "agent:ops:incident-42",
    );
  });

  it("honors configured main-key aliases when scoping legacy keys", () => {
    expect(
      scopeLegacySessionKeyToAgent({ agentId: "ops", sessionKey: "main", mainKey: "work" }),
    ).toBe("agent:ops:work");
  });

  it("preserves already agent-prefixed keys", () => {
    expect(
      scopeLegacySessionKeyToAgent({
        agentId: "ops",
        sessionKey: "agent:main:incident-42",
      }),
    ).toBe("agent:main:incident-42");
  });
});

describe("isUnscopedSessionKeySentinel", () => {
  it("recognizes literal global and unknown sentinels", () => {
    expect(isUnscopedSessionKeySentinel("global")).toBe(true);
    expect(isUnscopedSessionKeySentinel("UNKNOWN")).toBe(true);
    expect(isUnscopedSessionKeySentinel("agent:ops:global")).toBe(false);
    expect(isUnscopedSessionKeySentinel("incident-42")).toBe(false);
  });
});

describe("agentSessionKeysMatchByRequestKey", () => {
  it.each([
    ["incident-42", "agent:ops:incident-42", true],
    ["agent:OPS:incident-42", "agent:ops:incident-42", true],
    ["agent:ops:incident-42", "agent:research:incident-42", false],
    ["agent:ops:incident-42", "main", false],
  ] as const)("compares %s with %s without losing a qualified owner", (left, right, expected) => {
    expect(agentSessionKeysMatchByRequestKey(left, right)).toBe(expected);
  });
});

describe("resolveSessionStoreKey", () => {
  it("scopes unprefixed explicit-agent keys to the requested store agent", () => {
    const cfg = {
      agents: { entries: { main: {}, ops: {} } },
      session: { mainKey: "primary" },
    };

    expect(resolveSessionStoreKey({ cfg, sessionKey: "main", storeAgentId: "ops" })).toBe(
      "agent:ops:primary",
    );
    expect(resolveSessionStoreKey({ cfg, sessionKey: "discord:dm:U1", storeAgentId: "ops" })).toBe(
      "agent:ops:discord:dm:u1",
    );
  });
});

describe("thread session suffix parsing", () => {
  it("preserves feishu conversation ids that embed :topic: in the base id", () => {
    expect(
      parseThreadSessionSuffix(
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      ),
    ).toEqual({
      baseSessionKey:
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      threadId: undefined,
    });
  });

  it("parses mixed-case :thread: markers without lowercasing the stored key", () => {
    expect(
      parseThreadSessionSuffix("agent:main:slack:channel:General:Thread:1699999999.0001"),
    ).toEqual({
      baseSessionKey: "agent:main:slack:channel:General",
      threadId: "1699999999.0001",
    });
  });
});

describe("cron run scope suffix parsing", () => {
  it("parses mixed-case run markers without lowercasing the stored key", () => {
    expect(parseCronRunScopeSuffix("AGENT:Work:CRON:Nightly-Job:RUN:ABC-123")).toEqual({
      baseSessionKey: "AGENT:Work:CRON:Nightly-Job",
      runId: "ABC-123",
    });
  });

  it("does not strip a :run: segment from a non-cron key", () => {
    // The run scope is only ever appended to cron keys; a channel id that embeds
    // `:run:` must keep its identity intact.
    expect(parseCronRunScopeSuffix("agent:main:slack:channel:general:run:42")).toEqual({
      baseSessionKey: "agent:main:slack:channel:general:run:42",
      runId: undefined,
    });
  });

  it("does not treat a non-terminal cron :run: as a run scope", () => {
    expect(parseCronRunScopeSuffix("agent:main:cron:run:job:run:abc:extra")).toEqual({
      baseSessionKey: "agent:main:cron:run:job:run:abc:extra",
      runId: undefined,
    });
  });
});

describe("session key canonicalization", () => {
  it("does not double-prefix already-qualified agent keys", () => {
    expect(toAgentStoreSessionKey({ agentId: "main", requestKey: "agent:main:main" })).toBe(
      "agent:main:main",
    );
  });

  it("preserves Signal group ids in group history keys", () => {
    const peerId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    expect(buildGroupHistoryKey({ channel: "Signal", peerKind: "group", peerId })).toBe(
      `signal:default:group:${peerId}`,
    );
  });

  it("keeps non-Signal opaque-looking group ids lowercase", () => {
    expect(
      buildAgentPeerSessionKey({
        agentId: "Main",
        channel: "Telegram",
        peerKind: "group",
        peerId: "MiXeDGroup",
      }),
    ).toBe("agent:main:telegram:group:mixedgroup");
  });
});

describe("resolveEventSessionKey", () => {
  it("preserves durable cron base session keys", () => {
    expect(resolveEventSessionKey("agent:ops:cron:job-1")).toBe("agent:ops:cron:job-1");
  });

  it("respects custom mainKey for ephemeral cron session remapping", () => {
    expect(
      resolveEventSessionKey("agent:main:cron:backup:run:abc123", "primary", "per-sender"),
    ).toBe("agent:main:primary");
  });

  it("routes cron-run keys to the global queue when scope is global", () => {
    // Global-scope event consumers drain "global", not an agent-main queue.
    expect(resolveEventSessionKey("agent:ops:cron:job-1:run:xyz", undefined, "global")).toBe(
      "global",
    );
    expect(
      resolveEventSessionKey("agent:main:cron:backup:run:abc:subagent:worker", "primary", "global"),
    ).toBe("global");
  });
});
