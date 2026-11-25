import { assert, expect, it, vi } from "vitest";
import { renderAssistantRequestFailureCopy } from "../../agents/failover/assistant-request-failure-copy.js";
import { appendSessionManagerActor } from "../../agents/sessions/session-manager-actor-append.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  SqliteWorkerError,
} from "../../infra/sqlite-worker-contract.js";
import { withActor } from "./session-actor-transport.test-support.js";
import { throwSessionInputActorFailure } from "./session-input-actor.js";

// mock-isolation: This transport proof owns its database without background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture owns cleanup without background disk-budget eviction.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const authority = { assertCurrent() {}, authorize() {} };

it("preserves a prior unknown outcome when an actor command fails before native admission", async () => {
  await withActor(async ({ actor, fault }) => {
    const initial = await actor.read(authority);
    assert(actor.target.database.kind === "file");
    fault.beforeAdmissionError = Object.assign(
      new SqliteWorkerError("Carrier stopped", "unavailable"),
      {
        cause: new SqliteWorkerError("Prior write lost its result", "outcome-unknown"),
      },
    );
    const outcome = await actor.patch(
      {
        commandId: "not-admitted",
        phaseId: "turn",
        reducers: [{ kind: "activity", updatedAt: 456 }],
      },
      authority,
    );
    expect(outcome.kind).toBe("rolled-back");
    assert(outcome.kind === "rolled-back");
    expect(hasSqliteWorkerOutcomeUnknown(outcome.error)).toBe(true);
    const check = (error: unknown) => {
      expect(hasSqliteWorkerOutcomeUnknown(error)).toBe(true);
      const storageFailure = classifyGatewayStorageFailure(error);
      expect(storageFailure).toBe("session_actor_reconciliation");
      expect(renderAssistantRequestFailureCopy({ storageFailure })).toMatch(/check|reopen|retry/i);
      return true;
    };
    expect(() => throwSessionInputActorFailure(outcome)).toThrowError(expect.toSatisfy(check));
    await expect(
      appendSessionManagerActor({
        actor,
        toolResult: false,
        message: { role: "user" },
        assertCurrent() {},
        append: {
          kind: "message",
          input: {
            scope: {
              agentId: "main",
              storePath: actor.target.database.nativeLocation,
              sessionKey: actor.target.sessionKey,
              sessionId: initial.entry!.sessionId,
            },
            cwd: "/synthetic",
            messageJson: JSON.stringify({ role: "user", content: [] }),
          },
        },
      }),
    ).rejects.toSatisfy(check);
  });
});
