import { describe, expect, it } from "vitest";
import { withAgentTerminalPayloadSnapshot } from "../../agents/agent-terminal-snapshot.js";
import { captureAgentTerminalSnapshot } from "../../agents/embedded-agent-runner/run/attempt-terminal-snapshot.js";
import { resolveCronPayloadOutcome } from "./helpers.js";

describe("cron delivery outcomes", () => {
  it.each(["NO_REPLY", "no_r", "NO_R"])("keeps prepared literal %s visible", (text) => {
    const payloads = [{ text }, { text: "Scheduled result" }];
    const outcome = resolveCronPayloadOutcome({ payloads });
    expect(outcome.deliveryDisposition).toEqual({ kind: "visible" });
    expect(outcome.deliveryPayloads).toEqual(payloads);
    expect(resolveCronPayloadOutcome({ payloads: [{ text }] }).deliveryDisposition).toEqual({
      kind: "visible",
    });
  });

  it("keeps media visible even when its text is a silent acknowledgement", () => {
    const payload = { text: "NO_REPLY", mediaUrl: "https://example.com/update.png" };
    const outcome = resolveCronPayloadOutcome({ payloads: [payload] });

    expect(outcome.deliveryDisposition).toEqual({ kind: "visible" });
    expect(outcome.deliveryPayloads).toEqual([payload]);
  });
});

describe("selected native failure payload", () => {
  it("never lends a prior payload observation to an unowned replacement or recovered answer", () => {
    const snapshot = captureAgentTerminalSnapshot({
      terminalMessage: undefined,
      reachedPromptBoundary: true,
      success: false,
      hasHookError: true,
    });
    const owned = withAgentTerminalPayloadSnapshot(
      { text: "Native incomplete turn", isError: true },
      snapshot,
    );
    expect(resolveCronPayloadOutcome({ payloads: [owned] }).agentTerminal).toBe(snapshot);
    expect(
      resolveCronPayloadOutcome({ payloads: [owned, { text: "Replacement error", isError: true }] })
        .agentTerminal,
    ).toBeUndefined();
    expect(
      resolveCronPayloadOutcome({ payloads: [owned, { text: "Recovered answer" }] }).agentTerminal,
    ).toBeUndefined();
  });
});
