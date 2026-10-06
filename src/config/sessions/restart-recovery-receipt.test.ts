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
  const scope = () => ({
    sessionId: "session-1",
    sessionKey: "agent:main:discord:direct:123",
    sourceTurnId: "source-1",
    storePath: fixture.storePath(),
    toolCallId: "message-call-1",
  });
  const read = () => loadSessionEntry(scope());
  const seed = (fields: Partial<SessionEntry>) =>
    replaceSessionEntry(scope(), { sessionId: "session-1", updatedAt: 1, ...fields });
  const claim = {
    status: "running",
    restartRecoveryDeliveryRunId: "recovery-1",
    restartRecoveryDeliverySourceRunId: "source-1",
  } as const;

  it.each(["success", "non-delivery"] as const)(
    "persists pending and blocks repeat sends until provider %s",
    async (outcome) => {
      await seed(claim);
      await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("started");
      expect(read()).toMatchObject({
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryToolCallId: "message-call-1",
      });
      await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe(
        "delivery-ambiguous",
      );
      if (outcome === "success") {
        await expect(completeRestartRecoveryTerminalDelivery(scope())).resolves.toBe("recorded");
        expect(read()?.restartRecoveryDeliveryReceiptState).toBe("delivered-terminal");
      } else {
        await expect(cancelRestartRecoveryTerminalDelivery(scope())).resolves.toBe("cleared");
        expect(read()?.restartRecoveryDeliveryReceiptState).toBeUndefined();
        expect(read()?.restartRecoveryDeliveryToolCallId).toBeUndefined();
      }
    },
  );

  it.each<{
    name: string;
    fields: Partial<SessionEntry>;
    expected: string;
  }>([
    { name: "claimless live turn", fields: { status: undefined }, expected: "not-applicable" },
    { name: "claimless done turn", fields: { status: "done" }, expected: "not-applicable" },
    { name: "replaced claimless session", fields: { sessionId: "session-2" }, expected: "stale" },
    {
      name: "completed source with cleared claim",
      fields: { restartRecoveryTerminalRunIds: ["source-1"] },
      expected: "already-delivered",
    },
  ])("does not arm a receipt for $name", async ({ fields, expected }) => {
    await seed(fields);
    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe(expected);
    expect(read()?.restartRecoveryDeliveryReceiptState).toBeUndefined();
  });

  it("does not mutate a replacement session", async () => {
    await seed({
      ...claim,
      sessionId: "session-2",
      restartRecoveryDeliverySourceRunId: "source-2",
    });
    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    await expect(completeRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    await expect(cancelRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    expect(read()?.restartRecoveryDeliveryReceiptState).toBeUndefined();
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
