import { parseNodeWorkerComputerInput } from "../../worker/node-computer-protocol.js";
import { createWorkerComputerService } from "./computer-service.js";
import { EXECUTION_ID, createHarness } from "./computer-transport.test-support.js";
import type { WorkerEnvironmentRecord } from "./store.js";

/** A conversation-attached desktop whose native driver can no longer release its execution. */
export async function prepareWedgedAttachedComputer(
  environment: Partial<Pick<WorkerEnvironmentRecord, "environmentId" | "ownerEpoch">> = {},
) {
  const h = createHarness();
  h.releaseClaim();
  h.state.environment = {
    ...h.state.environment,
    ...environment,
    state: "ready",
    attachedSessionIds: [],
  };
  const computers = createWorkerComputerService(h.options);
  const { environmentId, ownerEpoch } = h.state.environment;
  const prepared = await computers.prepareAttached({
    environmentId,
    ownerEpoch,
    sessionId: h.claim.sessionId,
    sessionKey: h.state.placement.sessionKey,
    agentId: h.state.placement.agentId,
    runId: h.claim.runId,
    assertCurrent: () => {},
  });
  if (!prepared) {
    throw new Error("Expected an attached session desktop");
  }
  await prepared.bind(h.run).invoke({
    nodeId: prepared.descriptor.nodeId,
    command: "screen.snapshot",
    commandParams: { executionId: EXECUTION_ID, format: "png" },
  });
  const invoke = h.privateInvoke.getMockImplementation();
  if (!invoke) {
    throw new Error("Expected the private node fixture");
  }
  h.privateInvoke.mockImplementation(async (invocation) =>
    parseNodeWorkerComputerInput(JSON.stringify(invocation.params)).operation === "close"
      ? { ok: false, error: { code: "UNAVAILABLE", message: "DriverError.Tool" } }
      : await invoke(invocation),
  );
  return { h, computers, environmentId, ownerEpoch };
}
