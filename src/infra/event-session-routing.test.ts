import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
  resolveMainScopedEventSessionKey,
  scopedHeartbeatWakeOptionsForPolicy,
  type EventSessionRoutingPolicy,
} from "./event-session-routing.js";

const telegramSessionKey = "agent:main:telegram:work:direct:123";
const singleOwnerConfig: OpenClawConfig = {
  agents: { entries: { main: {} } },
  session: { dmScope: "main" },
  channels: { telegram: { accounts: { work: { allowFrom: ["123"] } } } },
};
function expectRoute(sessionKey: string, policy: EventSessionRoutingPolicy, destination: string) {
  expect(resolveEventSessionKeyForPolicy(sessionKey, policy)).toBe(destination);
  expect(scopedHeartbeatWakeOptionsForPolicy(sessionKey, { reason: "exec-event" }, policy)).toEqual(
    {
      reason: "exec-event",
      sessionKey: destination,
    },
  );
}

describe("event session routing", () => {
  it.each([
    ["account DM", 0],
    ["nested account DM", 1],
    ["account", 2],
    ["nested account", 3],
    ["channel DM", 4],
    ["channel", 5],
  ] as const)(
    "uses the first configured %s allowlist, including an empty list",
    (_source, first) => {
      for (const selected of [["123"], []]) {
        const lists = Array.from({ length: 6 }, (_, index) =>
          index < first ? undefined : index === first ? selected : [`other-${index}`],
        );
        const cfg: OpenClawConfig = {
          agents: { entries: { main: {} } },
          channels: {
            example: {
              dm: { allowFrom: lists[4] },
              allowFrom: lists[5],
              accounts: {
                work: {
                  dm: { allowFrom: lists[0] },
                  allowFrom: lists[2],
                  config: { dm: { allowFrom: lists[1] }, allowFrom: lists[3] },
                },
              },
            },
          },
        };
        const sessionKey = "agent:main:example:work:direct:123:thread:456";
        const policy = resolveEventSessionRoutingPolicy({ cfg, sessionKey });
        expect(policy.allowFrom).toEqual(selected);
        expect(resolveEventSessionKeyForPolicy(sessionKey, policy)).toBe(
          selected.length === 0 ? sessionKey : "agent:main:main",
        );
      }
    },
  );

  it.each([
    { channel: " Other ", accountId: " ALT ", expected: "override" },
    { channel: "", accountId: " ", expected: "original" },
  ])("resolves channel/account overrides $channel/$accountId", ({ expected, ...overrides }) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      channels: {
        example: { accounts: { work: { allowFrom: ["original"] } } },
        other: {
          accounts: { work: { allowFrom: ["other-work"] }, alt: { allowFrom: ["override"] } },
        },
      },
    };
    const params = { cfg, sessionKey: "agent:main:example:work:direct:123", ...overrides };
    expect(resolveEventSessionRoutingPolicy(params).allowFrom).toEqual([expected]);
  });

  it.each([
    ["agent:ops_1:example:direct:123:thread:", "agent:ops_1:main"],
    ["agent:ops_1:agent:other:example:direct:123:thread:t", null],
    ["agent:ops_1:example:group:123:thread:t", null],
  ] as const)("preserves direct event owner and thread parsing for %s", (sessionKey, expected) => {
    expect(
      resolveMainScopedEventSessionKey({
        cfg: { agents: { entries: { ops_1: {} } }, channels: { example: { allowFrom: ["123"] } } },
        sessionKey,
      }),
    ).toBe(expected);
  });

  it("routes single-owner dmScope=main direct event keys to the agent main session", () => {
    const sessionKey = telegramSessionKey;
    const policy = resolveEventSessionRoutingPolicy({ cfg: singleOwnerConfig, sessionKey });

    expectRoute(sessionKey, policy, "agent:main:main");
    expect(resolveEventSessionKeyForPolicy(`${sessionKey}:thread:1712345678.123`, policy)).toBe(
      "agent:main:main",
    );
  });

  it.each([{ allowFrom: ["123", "456"] }, { allowFrom: ["*"] }])(
    "does not route allowlist $allowFrom to main",
    ({ allowFrom }) => {
      expect(
        resolveMainScopedEventSessionKey({
          cfg: { ...singleOwnerConfig, channels: { telegram: { allowFrom } } },
          sessionKey: "agent:main:telegram:default:direct:123",
        }),
      ).toBeNull();
    },
  );

  it("preserves route-binding direct session overrides under global dmScope=main", () => {
    const sessionKey = telegramSessionKey;
    const cfg: OpenClawConfig = {
      ...singleOwnerConfig,
      bindings: [
        {
          type: "route",
          agentId: "main",
          match: { channel: "telegram", accountId: "work", peer: { kind: "direct", id: "123" } },
          session: { dmScope: "per-account-channel-peer" },
        },
      ],
    };
    for (const key of [sessionKey, `${sessionKey}:thread:1712345678.123`]) {
      const policy = resolveEventSessionRoutingPolicy({ cfg, sessionKey: key });
      expect(policy.preserveSessionKey).toBe(true);
      expect(resolveEventSessionKeyForPolicy(key, policy)).toBe(key);
    }
  });

  it("keeps cron-run remapping behavior unchanged", () => {
    expectRoute(
      "agent:ops:cron:nightly:run:abc",
      { mainKey: "primary", sessionScope: "per-sender" },
      "agent:ops:primary",
    );
  });
});
