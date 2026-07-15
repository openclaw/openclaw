import { describe, expect, it } from "vitest";
import { markRestartRecoveryTerminalReceiptFailure } from "./restart-recovery-receipt.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("restart recovery terminal receipt failure", () => {
  const fixture = useTempSessionsFixture("restart-receipt-");
  const sessionKey = "agent:main:discord:direct:123";

  it("marks only the exact active source claim fail closed", async () => {
    await replaceSessionEntry(
      { sessionKey, storePath: fixture.storePath() },
      {
        sessionId: "session-1",
        status: "running",
        restartRecoveryDeliveryRunId: "recovery-1",
        restartRecoveryDeliverySourceRunId: "source-1",
        updatedAt: 1,
      },
    );

    await expect(
      markRestartRecoveryTerminalReceiptFailure({
        sessionId: "session-1",
        sessionKey,
        sourceTurnId: "source-1",
        storePath: fixture.storePath(),
      }),
    ).resolves.toBe("marked");
    expect(loadSessionEntry({ sessionKey, storePath: fixture.storePath() })).toMatchObject({
      restartRecoveryDeliveryReceiptState: "unrecorded-terminal",
    });
  });

  it("does not write a late receipt failure into a replacement session", async () => {
    const replacementSessionKey = "agent:main:discord:direct:456";
    await replaceSessionEntry(
      { sessionKey: replacementSessionKey, storePath: fixture.storePath() },
      {
        sessionId: "session-2",
        status: "running",
        restartRecoveryDeliveryRunId: "recovery-2",
        restartRecoveryDeliverySourceRunId: "source-2",
        updatedAt: 1,
      },
    );

    await expect(
      markRestartRecoveryTerminalReceiptFailure({
        sessionId: "session-1",
        sessionKey: replacementSessionKey,
        sourceTurnId: "source-1",
        storePath: fixture.storePath(),
      }),
    ).resolves.toBe("stale");
    expect(
      loadSessionEntry({ sessionKey: replacementSessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBeUndefined();
  });
});
