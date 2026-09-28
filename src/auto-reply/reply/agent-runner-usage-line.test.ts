// Tests usage-line formatting for agent runner completion summaries.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { appendUsageLine, resolveResponseUsageLine } from "./agent-runner-usage-line.js";

describe("appendUsageLine", () => {
  it("marks a standalone usage footer as non-terminal status", () => {
    expect(
      appendUsageLine([{ mediaUrl: "file:///tmp/result.png" }], "Usage: 12 in / 3 out"),
    ).toEqual([
      { mediaUrl: "file:///tmp/result.png" },
      { text: "Usage: 12 in / 3 out", isStatusNotice: true },
    ]);
  });

  const completeUsage = { input: 1_000_000, output: 0 };
  it.each<
    [
      name: string,
      usage: Parameters<typeof resolveResponseUsageLine>[0]["usage"],
      tiered: boolean,
      expected: string | undefined,
    ]
  >([
    ["costless flat-price runtime", completeUsage, false, "est $1.00"],
    ["priced tool loop", { ...completeUsage, cost: { total: 0.25 } }, true, "est $0.25"],
    ["explicit zero total", { ...completeUsage, cost: { total: 0 } }, true, "est $0.0000"],
    ["incomplete tiered cost", completeUsage, true, undefined],
    ["input-only usage without a price", { input: 1_000_000 }, false, undefined],
    ["output-only usage without a price", { output: 50 }, false, undefined],
    [
      "partial usage with a recorded price",
      { input: 1000, cost: { total: 0.25 } },
      true,
      "est $0.25",
    ],
    ["partial usage with a recorded zero", { output: 50, cost: { total: 0 } }, true, "est $0.0000"],
    [
      "cost-only positive total",
      { cost: { total: 0.25 } },
      true,
      "Usage: ? in / ? out · est $0.25",
    ],
    ["cost-only zero total", { cost: { total: 0 } }, true, "Usage: ? in / ? out · est $0.0000"],
  ])("formats %s for the selected agent in an explicit fleet", (_name, usage, tiered, expected) => {
    const line = resolveResponseUsageLine({
      config: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, other: {} },
        },
        messages: { responseUsage: "full" },
        models: {
          providers: {
            fixture: {
              baseUrl: "https://fixture.invalid",
              models: [
                {
                  id: "priced",
                  name: "Priced",
                  reasoning: false,
                  input: ["text"],
                  cost: {
                    input: 1,
                    output: 2,
                    cacheRead: 0,
                    cacheWrite: 0,
                    ...(tiered
                      ? {
                          tieredPricing: [
                            { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, range: [200_000] },
                          ],
                        }
                      : {}),
                  },
                  contextWindow: 1,
                  maxTokens: 1,
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
      agentDir: "/tmp/openclaw-main-agent",
      usage,
      provider: "fixture",
      model: "priced",
    });

    expect(line).toContain("Usage:");
    if (expected) {
      expect(line).toContain(expected);
    } else {
      expect(line).not.toContain("est $");
    }
  });

  it.each(["off", "tokens"] as const)("hides cost-only usage in %s mode", (mode) => {
    expect(
      resolveResponseUsageLine({
        config: { messages: { responseUsage: mode } },
        agentDir: "/tmp/openclaw-main-agent",
        usage: { cost: { total: 0.25 } },
      }),
    ).toBeUndefined();
  });

  it("preserves reply payload metadata when appending usage text", () => {
    const payload = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:telegram:direct:123",
          agentId: "main",
          text: "message tool reply",
          idempotencyKey: "run-1:internal-source-reply:0",
        },
      },
    );

    const [updated] = appendUsageLine([payload], "Usage: 12 in / 3 out");

    expect(updated).toEqual({ text: "message tool reply\nUsage: 12 in / 3 out" });
    expect(getReplyPayloadMetadata(expectDefined(updated, "updated test invariant"))).toMatchObject(
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:telegram:direct:123",
          idempotencyKey: "run-1:internal-source-reply:0",
          text: "message tool reply\nUsage: 12 in / 3 out",
        },
      },
    );
  });
});
