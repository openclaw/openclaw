import { describe, expect, it } from "vitest";
import {
  beginRestartRecoveryTerminalDelivery,
  cancelRestartRecoveryTerminalDelivery,
  completeRestartRecoveryTerminalDelivery,
  resolveRestartRecoverySteeringBlockReason,
} from "./restart-recovery-receipt.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

describe("restart recovery terminal delivery receipt", () => {
  const fixture = useTempSessionsFixture("restart-receipt-");
  const sessionKey = "agent:main:discord:direct:123";

  async function seedClaim(params?: { sessionId?: string; sourceTurnId?: string }) {
    await replaceSessionEntry(
      { sessionKey, storePath: fixture.storePath() },
      {
        sessionId: params?.sessionId ?? "session-1",
        status: "running",
        restartRecoveryDeliveryRunId: "recovery-1",
        restartRecoveryDeliverySourceRunId: params?.sourceTurnId ?? "source-1",
        updatedAt: 1,
      },
    );
  }

  function scope(params?: { sessionId?: string; sourceTurnId?: string }) {
    return {
      sessionId: params?.sessionId ?? "session-1",
      sessionKey,
      sourceTurnId: params?.sourceTurnId ?? "source-1",
      storePath: fixture.storePath(),
      toolCallId: "message-call-1",
    };
  }

  it("persists pending before delivery and completion after provider success", async () => {
    await seedClaim();

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("started");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBe("terminal-pending");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryToolCallId,
    ).toBe("message-call-1");

    await expect(completeRestartRecoveryTerminalDelivery(scope())).resolves.toBe("recorded");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBe("delivered-terminal");
  });

  it("blocks a repeated terminal send while its outcome is already durable", async () => {
    await seedClaim();
    await beginRestartRecoveryTerminalDelivery(scope());

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("delivery-ambiguous");
  });

  it.each([undefined, "done" as const])(
    "does not arm a receipt for a live claimless turn with status %s",
    async (status) => {
      await replaceSessionEntry(
        { sessionKey, storePath: fixture.storePath() },
        {
          sessionId: "session-1",
          status,
          updatedAt: 1,
        },
      );

      await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("not-applicable");
      expect(
        loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
          ?.restartRecoveryDeliveryReceiptState,
      ).toBeUndefined();
    },
  );

  it("fails closed when the claimless live capability names a replaced session", async () => {
    await replaceSessionEntry(
      { sessionKey, storePath: fixture.storePath() },
      {
        sessionId: "session-2",
        updatedAt: 1,
      },
    );

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
  });

  it("blocks a completed source after its active recovery claim is cleared", async () => {
    await replaceSessionEntry(
      { sessionKey, storePath: fixture.storePath() },
      {
        sessionId: "session-1",
        restartRecoveryTerminalRunIds: ["source-1"],
        updatedAt: 1,
      },
    );

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("already-delivered");
  });

  it("clears pending only after a proven non-delivery", async () => {
    await seedClaim();
    await beginRestartRecoveryTerminalDelivery(scope());

    await expect(cancelRestartRecoveryTerminalDelivery(scope())).resolves.toBe("cleared");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBeUndefined();
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryToolCallId,
    ).toBeUndefined();
  });

  it("does not mutate a replacement session", async () => {
    await seedClaim({ sessionId: "session-2", sourceTurnId: "source-2" });

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    await expect(completeRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    await expect(cancelRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBeUndefined();
  });
});

describe("restart recovery steering block reasons", () => {
  const claim: Partial<SessionEntry> = {
    status: "running",
    restartRecoveryDeliveryRunId: "recovery-1",
    restartRecoveryDeliverySourceRunId: "source-1",
  };

  it.each<{
    name: string;
    fields?: Partial<SessionEntry>;
    sourceTurnId: string;
    reason: ReturnType<typeof resolveRestartRecoverySteeringBlockReason>;
  }>([
    {
      name: "terminal-pending receipt",
      fields: {
        ...claim,
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryToolCallId: "message-call-1",
      },
      sourceTurnId: "source-1",
      reason: "terminal-pending",
    },
    {
      name: "delivered-terminal receipt",
      fields: {
        ...claim,
        restartRecoveryDeliveryReceiptState: "delivered-terminal",
        restartRecoveryDeliveryToolCallId: "message-call-1",
      },
      sourceTurnId: "source-1",
      reason: "delivered-terminal",
    },
    {
      name: "unresolved terminal tool-call id",
      fields: { ...claim, restartRecoveryDeliveryToolCallId: "message-call-2" },
      sourceTurnId: "source-1",
      reason: "unresolved-terminal-tool",
    },
    {
      name: "terminal-source tombstone on the active source",
      fields: { status: "running", restartRecoveryTerminalRunIds: ["source-1"] },
      sourceTurnId: "source-1",
      reason: "already-delivered",
    },
    {
      name: "claimless entry with an unrelated tombstone",
      fields: { status: "running", restartRecoveryTerminalRunIds: ["source-old"] },
      sourceTurnId: "source-1",
      reason: undefined,
    },
    {
      name: "claimless entry with tombstones and an unknown active source",
      fields: { status: "running", restartRecoveryTerminalRunIds: ["source-old"] },
      sourceTurnId: "",
      reason: "unknown-source-with-terminal-history",
    },
    {
      name: "stale claim",
      fields: { ...claim, status: "done" },
      sourceTurnId: "source-1",
      reason: "stale-claim",
    },
    {
      name: "replaced session",
      fields: {
        status: "running",
        sessionId: "session-2",
        restartRecoveryTerminalRunIds: ["source-1"],
      },
      sourceTurnId: "source-1",
      reason: "stale-claim",
    },
    {
      name: "claimless fresh entry",
      fields: { status: "running" },
      sourceTurnId: "",
      reason: undefined,
    },
    {
      name: "startable live claim",
      fields: claim,
      sourceTurnId: "source-1",
      reason: undefined,
    },
    { name: "missing entry", sourceTurnId: "source-1", reason: undefined },
  ])("classifies $name", ({ fields, sourceTurnId, reason }) => {
    const entry = fields ? { sessionId: "session-1", updatedAt: 1, ...fields } : undefined;
    expect(resolveRestartRecoverySteeringBlockReason(entry, "session-1", sourceTurnId)).toBe(
      reason,
    );
  });
});
