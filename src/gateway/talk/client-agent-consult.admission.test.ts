import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import {
  captureAgentRunTerminalWriteContext,
  drainAgentRunTerminalWrites,
} from "../../infra/agent-run-terminal-writes.js";
import { settleTalkConsultAdmission } from "./client-agent-consult.js";

describe("settleTalkConsultAdmission", () => {
  it("keeps a finished consult open until accepted terminal writes drain", async () => {
    const operationalRunInstance = createOperationalRunInstanceRef("talk-consult-drain");
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance,
      facts: {
        runId: operationalRunInstance.runId,
        agentId: "main",
        ingress: { kind: "gateway-client", boundary: "talk-agent-consult", state: "present" },
      },
    });
    await admission.admit("embedded");
    const captured = captureAgentRunTerminalWriteContext(operationalRunInstance.runId);
    if (!captured) {
      throw new Error("expected a captured terminal write context");
    }
    const release = createDeferred();
    let writeFinished = false;
    captured.track(
      release.promise.then(() => {
        writeFinished = true;
      }),
    );
    let closed = false;
    const finish = settleTalkConsultAdmission({
      aborted: false,
      operationalRunInstance,
      close: () => {
        closed = true;
        admission.close();
      },
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(writeFinished).toBe(false);
    release.resolve();
    await finish;
    expect(writeFinished).toBe(true);
    expect(closed).toBe(true);
  });

  it("closes immediately on abort without waiting for a pending write", async () => {
    const operationalRunInstance = createOperationalRunInstanceRef("talk-consult-abort");
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance,
      facts: {
        runId: operationalRunInstance.runId,
        agentId: "main",
        ingress: { kind: "gateway-client", boundary: "talk-agent-consult", state: "present" },
      },
    });
    await admission.admit("embedded");
    const captured = captureAgentRunTerminalWriteContext(operationalRunInstance.runId);
    if (!captured) {
      throw new Error("expected a captured terminal write context");
    }
    const release = createDeferred();
    captured.track(release.promise);
    let closed = false;
    await settleTalkConsultAdmission({
      aborted: true,
      operationalRunInstance,
      close: () => {
        closed = true;
        admission.close();
      },
    });
    expect(closed).toBe(true);
    const drained = drainAgentRunTerminalWrites(operationalRunInstance);
    release.resolve();
    await drained;
  });
});
