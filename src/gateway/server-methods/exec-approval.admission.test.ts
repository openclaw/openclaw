import { describe, expect, it } from "vitest";
import { expectObjectFields } from "../../test-utils/mock-call-assertions.js";
import { createChatAbortMarker } from "../server-chat-state.js";
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
        message: "approval run already aborted",
        details: { reason: "EXEC_APPROVAL_RUN_ABORTED" },
      });
      expect(await manager.listPendingRecords()).toEqual([]);
      expect(broadcasts).toEqual([]);
    });
  });
});
