import { describe, it, expect, vi } from "vitest";
import { commitMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { readSessionMessagesAsync } from "../session-transcript-readers.js";
import { admitAgentRestartRecovery } from "./agent-run-recovery-admission.js";

vi.mock("../../agents/main-session-recovery/main-session-recovery-store.js", () => ({
  commitMainSessionRecovery: vi.fn(),
}));
vi.mock("../session-transcript-readers.js", () => ({ readSessionMessagesAsync: vi.fn() }));
const saved: InternalSessionEntry = {
  sessionId: "session",
  updatedAt: 1,
  lifecycleRevision: "original-lifecycle",
  restartRecoverySourceIngress: "channel",
  restartRecoveryDeliverySourceRunId: "source",
  restartRecoveryDeliveryContext: {
    channel: "slack",
    to: "D1",
    accountId: "account",
    threadId: "T1",
  },
  restartRecoveryRequesterSenderId: "U1",
  restartRecoveryRequesterAccountId: "account",
};
async function read(current: InternalSessionEntry, expected = saved) {
  const identity = {
    lifecycleGeneration: "generation",
    runId: "recovery",
    sessionId: saved.sessionId,
  };
  vi.mocked(commitMainSessionRecovery).mockResolvedValueOnce({
    entry: current,
    transition: {
      kind: "admitted_recovery",
      undispatchedSourceTurnId: "source",
      admission: { ...identity, cycleId: "cycle", attempt: 1 },
    },
  });
  const admission = await admitAgentRestartRecovery({
    ...identity,
    sessionKey: "agent:main:main",
    storePath: "/unused",
  });
  return admission.readUndispatchedInput(expected);
}

describe("undispatched channel input ownership", () => {
  it.each([
    { sessionId: "other" },
    { lifecycleRevision: "replacement-lifecycle" },
    { restartRecoveryRequesterSenderId: "U2" },
    { restartRecoveryRequesterAccountId: "other" },
    { restartRecoveryDeliverySourceRunId: "other" },
    { restartRecoveryDeliveryContext: { ...saved.restartRecoveryDeliveryContext, to: "D2" } },
    { restartRecoveryDeliveryContext: { ...saved.restartRecoveryDeliveryContext, threadId: "T2" } },
  ])("refuses changed identity or target before fetching source text %o", async (changes) => {
    vi.mocked(readSessionMessagesAsync).mockClear();
    await expect(read({ ...saved, ...changes })).rejects.toThrow("ownership changed");
    expect(readSessionMessagesAsync).not.toHaveBeenCalled();
  });
  it("rejects two equally missing destinations", async () => {
    const missing = { ...saved, restartRecoveryDeliveryContext: undefined };
    await expect(read(missing, missing)).rejects.toThrow("ownership changed");
  });
  it("refuses a newer transcript message instead of guessing the original input", async () => {
    vi.mocked(readSessionMessagesAsync).mockResolvedValueOnce([
      { role: "user", content: "different", idempotencyKey: "next" },
    ]);
    await expect(read(saved)).rejects.toThrow("original undispatched channel input is unavailable");
  });
});
