import { describe, expect, it, vi } from "vitest";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import {
  beginRestartRecoveryTerminalDelivery as begin,
  cancelRestartRecoveryTerminalDelivery as cancel,
  completeRestartRecoveryTerminalDelivery as complete,
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
      await expect(begin(scope())).resolves.toBe("started");
      expect(read()).toMatchObject({
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryToolCallId: "message-call-1",
      });
      await expect(begin(scope())).resolves.toBe("delivery-ambiguous");
      if (outcome === "success") {
        await expect(complete(scope())).resolves.toBe("recorded");
        await expect(complete(scope())).resolves.toBe("recorded");
        await expect(cancel(scope())).resolves.toBe("stale");
        expect(read()?.restartRecoveryDeliveryReceiptState).toBe("delivered-terminal");
        expect(read()?.restartRecoveryDeliveryToolCallId).toBe("message-call-1");
      } else {
        await expect(cancel(scope())).resolves.toBe("cleared");
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
    await expect(begin(scope())).resolves.toBe(expected);
    expect(read()?.restartRecoveryDeliveryReceiptState).toBeUndefined();
  });

  it("does not mutate a replacement session", async () => {
    await seed({
      ...claim,
      sessionId: "session-2",
      restartRecoveryDeliverySourceRunId: "source-2",
    });
    await expect(begin(scope())).resolves.toBe("stale");
    await expect(complete(scope())).resolves.toBe("stale");
    await expect(cancel(scope())).resolves.toBe("stale");
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
        await expect(begin(scope())).resolves.toBe(change === "metadata" ? "started" : "stale");
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
      await expect(begin(scope())).resolves.toBe("started");
      const pending = read();
      const other = {
        ...scope(),
        ...(mismatch === "source"
          ? { sourceTurnId: "source-2" }
          : { toolCallId: "message-call-2" }),
      };
      await expect(begin(other)).resolves.toBe(
        mismatch === "source" ? "stale" : "delivery-ambiguous",
      );
      if (mismatch === "source") {
        await expect(complete(other)).resolves.toBe("stale");
        await expect(cancel(other)).resolves.toBe("stale");
      } else {
        await expect(complete(other)).rejects.toThrow(
          "failed to persist terminal delivery completion",
        );
        await expect(cancel(other)).rejects.toThrow("failed to clear terminal delivery intent");
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

  const receipt = (state: SessionEntry["restartRecoveryDeliveryReceiptState"]) => ({
    ...claim,
    restartRecoveryDeliveryReceiptState: state,
    restartRecoveryDeliveryToolCallId: "message-call-1",
  });
  const tombstone = (source: string) => ({
    status: undefined,
    restartRecoveryTerminalRunIds: [source],
  });
  type Reason = ReturnType<typeof resolveRestartRecoverySteeringBlockReason>;
  const row = (
    name: string,
    fields: Partial<SessionEntry> | undefined,
    reason?: Reason,
    sourceTurnId = "source-1",
  ) => ({ name, fields, sourceTurnId, reason });
  it.each([
    row("terminal-pending receipt", receipt("terminal-pending"), "terminal-pending"),
    row("delivered-terminal receipt", receipt("delivered-terminal"), "delivered-terminal"),
    row(
      "unresolved terminal tool-call id",
      { ...claim, restartRecoveryDeliveryToolCallId: "message-call-2" },
      "unresolved-terminal-tool",
    ),
    row(
      "terminal-source tombstone on the active source",
      tombstone("source-1"),
      "already-delivered",
    ),
    row("claimless entry with an unrelated tombstone", tombstone("source-old")),
    row(
      "claimless entry with tombstones and an unknown active source",
      tombstone("source-old"),
      "unknown-source-with-terminal-history",
      "",
    ),
    row(
      "stale claim",
      { ...claim, status: "done", restartRecoveryDeliverySourceRunId: "source-2" },
      "stale-claim",
    ),
    row("replaced session", { ...tombstone("source-1"), sessionId: "session-2" }, "stale-claim"),
    row("claimless fresh entry", { status: undefined }, undefined, ""),
    ...([undefined, "done", "interrupted"] as const).map((status) =>
      row(`exact source claim with outcome ${status}`, { ...claim, status }),
    ),
    row("missing entry", undefined),
  ])("classifies $name", ({ fields, sourceTurnId, reason }) => {
    const entry = fields ? { sessionId: "session-1", updatedAt: 1, ...fields } : undefined;
    expect(resolveRestartRecoverySteeringBlockReason(entry, "session-1", sourceTurnId)).toBe(
      reason,
    );
  });
});
