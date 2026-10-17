import { describe, expect, it } from "vitest";
import {
  answerCliHistoryOwnerProbe,
  createCliHistoryOwnerProbe,
  type CliHistoryWriter,
} from "./cli-history-boundary.js";

describe("CLI history owner probe", () => {
  // The native owner check rereads the login and can throw (an unreadable credentials file).
  it("treats an owner check that throws as not holding", () => {
    const probe = createCliHistoryOwnerProbe();
    const failing: CliHistoryWriter = {
      target: { agentId: "main", sessionId: "s", sessionKey: "agent:main:s", storePath: "/db" },
      runId: "run",
      authFingerprint: "f".repeat(64),
      lifecycleRevision: "rev",
      assertCurrent: () => {},
      assertReadable: () => {},
      confirmsOwner: () => {
        throw new Error("Keychain lookup failed");
      },
    };
    expect(answerCliHistoryOwnerProbe(probe.fact, failing)).toBe(true);
    expect(probe.holds()).toBe(false);
  });
});
