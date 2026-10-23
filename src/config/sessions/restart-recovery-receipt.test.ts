import { describe, expect, it, vi } from "vitest";
import { renderAssistantRequestFailureCopy } from "../../agents/failover/assistant-request-failure-copy.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import {
  beginRestartRecoveryTerminalDelivery as begin,
  cancelRestartRecoveryTerminalDelivery as cancel,
  completeRestartRecoveryTerminalDelivery as complete,
  resolveRestartRecoverySteeringBlockReason as blockReason,
} from "./restart-recovery-receipt.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import * as sessionActors from "./session-actor.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

const claim = {
  restartRecoveryDeliveryRunId: "recovery-1",
  restartRecoveryDeliverySourceRunId: "source-1",
} as const;
const entry = (fields: Partial<SessionEntry>): SessionEntry => ({
  sessionId: "session-1",
  updatedAt: 1,
  ...fields,
});

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
  const seed = (fields: Partial<SessionEntry>) => replaceSessionEntry(scope(), entry(fields));

  it("preserves storage guidance when terminal delivery admission has an unknown outcome", async () => {
    await seed(claim);
    const before = read();
    const createActor = sessionActors.createSessionActor;
    const observer = vi.spyOn(sessionActors, "createSessionActor").mockImplementation((params) => {
      const actor = createActor(params);
      vi.spyOn(actor, "deliveryPending").mockResolvedValue({
        kind: "unknown",
        target: actor.target,
        commandId: "storage-failure",
        error: {
          name: "Error",
          message: "Unconfirmed actor settlement",
          cause: Object.assign(new Error("database or disk is full"), { errcode: 13 }),
        },
      });
      return actor;
    });
    try {
      await expect(begin(scope())).rejects.toSatisfy((error: unknown) => {
        expect(
          renderAssistantRequestFailureCopy({
            storageFailure: classifyGatewayStorageFailure(error),
          }),
        ).toContain("disk is full. Free up space");
        return hasSqliteWorkerOutcomeUnknown(error);
      });
      expect(read()).toEqual(before);
    } finally {
      observer.mockRestore();
    }
  });

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
      } else {
        await expect(cancel(scope())).resolves.toBe("cleared");
      }
      const receipt = read();
      expect(receipt?.restartRecoveryDeliveryReceiptState).toBe(
        outcome === "success" ? "delivered-terminal" : undefined,
      );
      expect(receipt?.restartRecoveryDeliveryToolCallId).toBe(
        outcome === "success" ? "message-call-1" : undefined,
      );
    },
  );

  it.each<[string, Partial<SessionEntry>, string]>([
    ["claimless live turn", { status: undefined }, "not-applicable"],
    ["replaced claimless session", { sessionId: "session-2" }, "stale"],
    ["completed source", { restartRecoveryTerminalRunIds: ["source-1"] }, "already-delivered"],
  ])("does not arm a receipt for %s", async (_name, fields, expected) => {
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
  const receipt = (state: SessionEntry["restartRecoveryDeliveryReceiptState"]) => ({
    ...claim,
    restartRecoveryDeliveryReceiptState: state,
    restartRecoveryDeliveryToolCallId: "message-call-1",
  });
  const tombstone = (source: string) => ({ restartRecoveryTerminalRunIds: [source] });
  type Reason = ReturnType<typeof blockReason>;
  it.each<[Partial<SessionEntry> | undefined, Reason?, string?]>([
    [receipt("terminal-pending"), "terminal-pending"],
    [receipt("delivered-terminal"), "delivered-terminal"],
    [{ ...claim, restartRecoveryDeliveryToolCallId: "message-call-2" }, "unresolved-terminal-tool"],
    [tombstone("source-1"), "already-delivered"],
    [tombstone("source-old")],
    [tombstone("source-old"), "unknown-source-with-terminal-history", ""],
    [{ ...claim, status: "done", restartRecoveryDeliverySourceRunId: "source-2" }, "stale-claim"],
    [claim, undefined, "recovery-1"],
    [claim, "stale-claim", "other-run"],
    [{ ...tombstone("source-1"), sessionId: "session-2" }, "stale-claim"],
    [{ status: undefined }, undefined, ""],
    [claim],
    [undefined],
  ])("classifies %j as %s", (fields, reason, sourceTurnId = "source-1") => {
    expect(blockReason(fields && entry(fields), "session-1", sourceTurnId)).toBe(reason);
  });
});
