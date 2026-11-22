import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { expectObjectFields } from "../../test-utils/mock-call-assertions.js";
import { getOperatorApprovalDetailed } from "../operator-approval-store.js";
import { createChatAbortMarker } from "../server-chat-state.js";
import { cancelUnboundRunApprovals } from "./approval-run-cancellation.js";
import { createExecApprovalFixture, requestExecApproval } from "./exec-approval.test-support.js";

describe("exec approval admission", () => {
  it("rejects approval registration after the owning run was aborted", async (testContext) => {
    const fixture = await createExecApprovalFixture(testContext, { preparePersistence: false });
    return await fixture.run(async () => {
      const { manager, handlers, broadcasts, respond, context } = fixture;
      context.chatRunState.getOrCreate("run-aborted").abortMarker = createChatAbortMarker();

      await requestExecApproval({
        handlers,
        respond,
        context,
        params: {
          runId: "run-aborted",
          toolCallId: "tool-late",
          host: "gateway",
          command: "echo too-late",
          commandArgv: ["echo", "too-late"],
          systemRunPlan: undefined,
          nodeId: undefined,
        },
      });

      const [ok, , error] = respond.mock.calls[0] ?? [];
      expect(ok).toBe(false);
      expectObjectFields(error, {
        message: "The approval run was stopped. Start a new turn to request approval again.",
        details: { reason: "EXEC_APPROVAL_RUN_ABORTED" },
      });
      expect(await manager.listPendingRecords()).toEqual([]);
      expect(broadcasts).toEqual([]);
    });
  });

  it("cancels a Stop during approval preparation before prompting", async (testContext) => {
    const fixture = await createExecApprovalFixture(testContext);
    return await fixture.run(async () => {
      const { manager, handlers, broadcasts, respond, context } = fixture;
      const prompted = createDeferredCore();
      const broadcast = context.broadcast;
      context.broadcast = (event, payload) => {
        broadcast(event, payload);
        if (event === "exec.approval.requested") {
          prompted.resolve();
        }
      };
      const getSnapshot = manager.getSnapshot.bind(manager);
      const preparation = vi.spyOn(manager, "getSnapshot").mockImplementationOnce(async (id) => {
        const snapshot = await getSnapshot(id);
        context.chatRunState.getOrCreate("run-stopped-during-preparation").abortMarker =
          createChatAbortMarker();
        expect(
          await cancelUnboundRunApprovals({
            manager,
            runId: "run-stopped-during-preparation",
            publish: () => {},
          }),
        ).toBe(0);
        return snapshot;
      });
      try {
        const request = requestExecApproval({
          handlers,
          respond,
          context,
          params: {
            id: "stopped-preparation-approval",
            runId: "run-stopped-during-preparation",
            twoPhase: true,
            timeoutMs: 60_000,
          },
        });
        await Promise.race([request, prompted.promise]);
        if (manager.getLocalSnapshot("stopped-preparation-approval")?.resolvedAtMs === undefined) {
          await manager.expire("stopped-preparation-approval");
        }
        await request;
        expect(
          await getOperatorApprovalDetailed({
            id: "stopped-preparation-approval",
            databaseOptions: fixture.databaseOptions,
          }),
        ).toMatchObject({
          outcome: "found",
          record: { status: "cancelled", terminalReason: "run-aborted", decision: "deny" },
        });
        expect(await manager.listPendingRecords()).toEqual([]);
        expect(broadcasts.filter(({ event }) => event === "exec.approval.requested")).toEqual([]);
        expect(respond.mock.calls).toEqual([
          [
            false,
            undefined,
            expect.objectContaining({
              message: "The approval run was stopped. Start a new turn to request approval again.",
              details: { reason: "EXEC_APPROVAL_RUN_ABORTED" },
            }),
          ],
        ]);
      } finally {
        preparation.mockRestore();
      }
    });
  });
});
