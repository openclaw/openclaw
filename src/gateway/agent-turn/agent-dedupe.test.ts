import { describe, expect, it } from "vitest";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { DedupeEntry } from "../server-shared.js";
import { readAcceptedAgentRunReplyText } from "./agent-dedupe.js";
import { setGatewayDedupeEntry } from "./agent-job.js";

describe("readAcceptedAgentRunReplyText", () => {
  it.each([
    "matched",
    "other-run",
    "session-id",
    "agent-id",
    "session-key",
    "evicted",
    "incognito",
    "not-ok",
    "status",
    "generation",
  ])("reads only the accepted retained successful run (%s)", (variant) => {
    const accepted = {
      runId: `dedupe-${variant}`,
      agentId: "main",
      sessionKey: "agent:main:worker",
      sessionId: "worker-id",
    };
    const full = "A".repeat(5_000) + "DEDUPE_TAIL";
    const context = { dedupe: new Map<string, DedupeEntry>() };
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `agent:${accepted.runId}`,
      session: {
        ...accepted,
        lifecycleGeneration:
          variant === "generation" ? "old-generation" : getAgentEventLifecycleGeneration(),
      },
      entry: {
        ts: Date.now(),
        ok: variant !== "not-ok",
        ...(variant === "incognito" ? { incognito: true as const } : {}),
        payload: {
          runId: variant === "other-run" ? "other" : accepted.runId,
          status: variant === "status" ? "error" : "ok",
          result: { meta: { finalAssistantVisibleText: full } },
        },
      },
    });
    if (variant === "evicted") {
      context.dedupe.clear();
    }
    const requested = {
      ...accepted,
      ...(variant === "session-id" ? { sessionId: "another" } : {}),
      ...(variant === "agent-id" ? { agentId: "another" } : {}),
      ...(variant === "session-key" ? { sessionKey: "another" } : {}),
    };
    expect(readAcceptedAgentRunReplyText(context, requested)).toBe(
      variant === "matched" ? full : undefined,
    );
  });
});
