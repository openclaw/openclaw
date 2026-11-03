// Reset preempts a running ACP turn through Stop before it cleans up the ACP runtime.
import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withAcpCancellationFixture } from "../acp/control-plane/manager.cancel-session.worker.test-support.js";
import { testing as acpManagerTesting } from "../acp/control-plane/manager.js";
import { readAcpSessionMetaAsync } from "../acp/runtime/session-meta.js";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
import type { AcpRuntimeEvent } from "../plugin-sdk/acp-runtime.js";
import { performGatewaySessionReset } from "./session-reset-service.js";

it("reset preempts a running ACP turn through Stop, then cancels its idle runtime", async () => {
  await withAcpCancellationFixture(async (f) => {
    await f.state.writeConfig(f.target.cfg);
    acpManagerTesting.setAcpSessionManagerForTests(f.manager);
    const entered = createDeferred();
    f.runTurn.mockImplementationOnce(async function* (input) {
      entered.resolve();
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "done", status: "cancelled" };
    });
    const events: AcpRuntimeEvent[] = [];
    const turn = f.manager.runTurn({
      ...f.target,
      admittedRunContext: createTestAdmittedRunContext("reset-running"),
      provenance: "system",
      mode: "prompt",
      text: "running",
      requestId: "reset-running",
      onEvent: (event) => {
        events.push(event);
      },
    });
    try {
      await entered.promise;
      const reset = await performGatewaySessionReset({
        key: f.target.sessionKey,
        agentId: f.target.agentId,
        reason: "reset",
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
      });
      expect(reset).toMatchObject({ ok: true });
      await turn;
      expect(events.at(-1)).toMatchObject({ type: "done", status: "cancelled" });
      // The mutation's Stop cancels the running turn; reset cleanup then cancels the idle backend.
      expect(f.cancel).toHaveBeenCalledTimes(2);
      expect((await readAcpSessionMetaAsync(f.target))?.state).toBe("idle");
    } finally {
      acpManagerTesting.resetAcpSessionManagerForTests();
      await turn.catch(() => {});
    }
  });
});
