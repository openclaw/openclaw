import { describe, expect, it, vi } from "vitest";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import {
  beginRestartRecoveryTerminalDelivery,
  cancelRestartRecoveryTerminalDelivery,
  completeRestartRecoveryTerminalDelivery,
  resolveRestartRecoverySteeringBlockReason,
} from "./restart-recovery-receipt.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

// mock-isolation: Receipt command counts exclude fixture-seeding maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));

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
        await expect(completeRestartRecoveryTerminalDelivery(scope())).resolves.toBe("recorded");
        await expect(cancelRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
        expect(read()?.restartRecoveryDeliveryReceiptState).toBe("delivered-terminal");
        expect(read()?.restartRecoveryDeliveryToolCallId).toBe("message-call-1");
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

  it.each(["metadata", "source"] as const)(
    "adopts command-local state without replacing a newer %s or issuing a read",
    async (change) => {
      await seed(claim);
      const initial = read()!;
      const capture = agentExecution.captureOpenClawAgentDatabaseExecution;
      const commands: string[] = [];
      let changed = false;
      const observer = vi
        .spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution")
        .mockImplementation((...args) => {
          const owner = capture(...args);
          return {
            ...owner,
            get fileIdentity() {
              return owner.fileIdentity;
            },
            runExisting: (source, run, options) =>
              owner.runExisting(
                source,
                (worker) =>
                  run({
                    execute(command, commandOptions) {
                      commands.push(command.type);
                      if (command.type === "session.actor.deliveryPending" && !changed) {
                        changed = true;
                        replaceSessionEntrySync(scope(), {
                          ...initial,
                          ...(change === "metadata"
                            ? { label: "new metadata" }
                            : { restartRecoveryDeliverySourceRunId: "new-source" }),
                        });
                      }
                      return worker.execute(command, commandOptions);
                    },
                  }),
                options,
              ),
          };
        });
      try {
        await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe(
          change === "metadata" ? "started" : "stale",
        );
        expect(commands).toEqual(["session.actor.deliveryPending"]);
        if (change === "metadata") {
          expect(read()).toMatchObject({
            label: "new metadata",
            restartRecoveryDeliveryReceiptState: "terminal-pending",
          });
        } else {
          expect(read()).toMatchObject({ restartRecoveryDeliverySourceRunId: "new-source" });
          expect(read()?.restartRecoveryDeliveryReceiptState).toBeUndefined();
        }
      } finally {
        observer.mockRestore();
      }
    },
  );

  it.each(["source", "tool"] as const)(
    "preserves pending custody when settlement names another %s",
    async (mismatch) => {
      await seed(claim);
      await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("started");
      const pending = read();
      const other = {
        ...scope(),
        ...(mismatch === "source"
          ? { sourceTurnId: "source-2" }
          : { toolCallId: "message-call-2" }),
      };
      await expect(beginRestartRecoveryTerminalDelivery(other)).resolves.toBe(
        mismatch === "source" ? "stale" : "delivery-ambiguous",
      );
      if (mismatch === "source") {
        await expect(completeRestartRecoveryTerminalDelivery(other)).resolves.toBe("stale");
        await expect(cancelRestartRecoveryTerminalDelivery(other)).resolves.toBe("stale");
      } else {
        await expect(completeRestartRecoveryTerminalDelivery(other)).rejects.toThrow(
          "failed to persist terminal delivery completion",
        );
        await expect(cancelRestartRecoveryTerminalDelivery(other)).rejects.toThrow(
          "failed to clear terminal delivery intent",
        );
      }
      expect(read()).toEqual(pending);
    },
  );
});

describe("restart recovery steering block reasons", () => {
  const claim: Partial<SessionEntry> = {
    status: undefined,
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
      fields: { status: undefined, restartRecoveryTerminalRunIds: ["source-1"] },
      sourceTurnId: "source-1",
      reason: "already-delivered",
    },
    {
      name: "claimless entry with an unrelated tombstone",
      fields: { status: undefined, restartRecoveryTerminalRunIds: ["source-old"] },
      sourceTurnId: "source-1",
      reason: undefined,
    },
    {
      name: "claimless entry with tombstones and an unknown active source",
      fields: { status: undefined, restartRecoveryTerminalRunIds: ["source-old"] },
      sourceTurnId: "",
      reason: "unknown-source-with-terminal-history",
    },
    {
      name: "stale claim",
      fields: { ...claim, status: "done", restartRecoveryDeliverySourceRunId: "source-2" },
      sourceTurnId: "source-1",
      reason: "stale-claim",
    },
    {
      name: "replaced session",
      fields: {
        status: undefined,
        sessionId: "session-2",
        restartRecoveryTerminalRunIds: ["source-1"],
      },
      sourceTurnId: "source-1",
      reason: "stale-claim",
    },
    {
      name: "claimless fresh entry",
      fields: { status: undefined },
      sourceTurnId: "",
      reason: undefined,
    },
    ...([undefined, "done", "interrupted"] as const).map((status) => ({
      name: `exact source claim with outcome ${status}`,
      fields: { ...claim, status },
      sourceTurnId: "source-1",
      reason: undefined,
    })),
    { name: "missing entry", sourceTurnId: "source-1", reason: undefined },
  ])("classifies $name", ({ fields, sourceTurnId, reason }) => {
    const entry = fields ? { sessionId: "session-1", updatedAt: 1, ...fields } : undefined;
    expect(resolveRestartRecoverySteeringBlockReason(entry, "session-1", sourceTurnId)).toBe(
      reason,
    );
  });
});
