import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";

let applyCrossContextDecoration: typeof import("./outbound-policy.js").applyCrossContextDecoration;
let buildCrossContextDecoration: typeof import("./outbound-policy.js").buildCrossContextDecoration;
let enforceCrossContextPolicy: typeof import("./outbound-policy.js").enforceCrossContextPolicy;

const mocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn<(channel: string) => Partial<ChannelPlugin> | undefined>((channel) => {
    if (channel === "slack") {
      return {
        threading: {
          matchesToolContextTarget: ({ target, toolContext }) =>
            target === "U123" && toolContext.currentMessagingTarget === "user:U123",
        },
      };
    }
    if (channel === "richchat") {
      return {
        messaging: {
          buildCrossContextPresentation: ({ originLabel, message }) => ({
            blocks: [
              ...(message.trim() ? [{ type: "text" as const, text: message }] : []),
              { type: "context" as const, text: `From ${originLabel}` },
            ],
          }),
        },
      };
    }
    return undefined;
  }),
  normalizeTargetForProvider: vi.fn((channel: string, raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    return channel === "workspace" ? trimmed.replace(/^#/, "") : trimmed;
  }),
  lookupDirectoryDisplay: vi.fn(async ({ targetId }: { targetId: string }) =>
    targetId.replace(/^#/, ""),
  ),
  formatTargetDisplay: vi.fn(
    ({ target, display }: { target: string; display?: string }) => display ?? target,
  ),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
}));

vi.mock("./target-normalization.js", () => ({
  normalizeTargetForProvider: mocks.normalizeTargetForProvider,
}));

vi.mock("./target-resolver.js", () => ({
  formatTargetDisplay: mocks.formatTargetDisplay,
  lookupDirectoryDisplay: mocks.lookupDirectoryDisplay,
}));

function expectCrossContextPolicyResult(
  expected: "allow" | RegExp,
  params: Parameters<typeof enforceCrossContextPolicy>[0],
) {
  const run = () => enforceCrossContextPolicy(params);
  if (expected === "allow") {
    expect(run()).toBeUndefined();
    return;
  }
  expect(run).toThrow(expected);
}

describe("outbound policy helpers", () => {
  beforeAll(async () => {
    ({ applyCrossContextDecoration, buildCrossContextDecoration, enforceCrossContextPolicy } =
      await import("./outbound-policy.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { name: "default cross-provider access", provider: "webchat", expected: "allow" as const },
    {
      name: "explicit cross-provider denial",
      provider: "webchat",
      policy: { allowAcrossProviders: false },
      expected: /target provider/,
    },
    {
      name: "same-provider targetless context",
      provider: "discord",
      policy: { allowWithinProvider: false },
      expected: "allow" as const,
    },
  ])("preserves $name without a current target", ({ provider, policy, expected }) => {
    expectCrossContextPolicyResult(expected, {
      cfg: { tools: { message: { crossContext: policy } } },
      channel: "discord",
      action: "send",
      args: { to: "channel:123" },
      toolContext: { currentChannelProvider: provider },
    });
  });

  it("guards a dice roll like any other target-addressed send", () => {
    // A roll is recipient-visible and addressed by `to`, so it clears the same guard.
    expectCrossContextPolicyResult(/target="C999" while bound to "C123"/, {
      cfg: {
        channels: { workspace: { botToken: "workspace-test", appToken: "workspace-app-test" } },
        tools: { message: { crossContext: { allowWithinProvider: false } } },
      } as OpenClawConfig,
      channel: "workspace",
      action: "dice",
      args: { to: "C999" },
      toolContext: { currentChannelId: "C123", currentChannelProvider: "workspace" },
    });
  });

  it("enforces the agent's cross-context policy", () => {
    expectCrossContextPolicyResult(/target="C999" while bound to "C123"/, {
      cfg: {
        channels: { workspace: { botToken: "workspace-test", appToken: "workspace-app-test" } },
        agents: {
          entries: {
            sandbox: {
              tools: { message: { crossContext: { allowWithinProvider: false } } },
            },
          },
        },
      } as OpenClawConfig,
      channel: "workspace",
      action: "send",
      args: { to: "C999" },
      toolContext: { currentChannelId: "C123", currentChannelProvider: "workspace" },
      agentId: "sandbox",
    });
  });

  it("allows a routable alias of the native current channel", () => {
    expect(() =>
      enforceCrossContextPolicy({
        channel: "slack",
        action: "send",
        args: { to: "U123" },
        toolContext: {
          currentChannelId: "D123",
          currentMessagingTarget: "user:U123",
          currentChannelProvider: "slack",
        },
        cfg: { tools: { message: { crossContext: { allowWithinProvider: false } } } },
      }),
    ).not.toThrow();
  });

  it("uses presentation when available and preferred", async () => {
    const decoration = await buildCrossContextDecoration({
      cfg: { channels: { richchat: {} } } as OpenClawConfig,
      channel: "richchat",
      target: "123",
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "richchat" },
    });

    if (!decoration) {
      throw new Error("Expected cross-context decoration");
    }
    const applied = applyCrossContextDecoration({
      message: "hello",
      decoration,
      preferPresentation: true,
    });

    expect(applied.presentation?.blocks.length).toBeGreaterThan(0);
    expect(applied.message).toBe("hello");
  });
});
