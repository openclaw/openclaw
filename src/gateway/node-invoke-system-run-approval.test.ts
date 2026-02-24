import { describe, expect, test } from "vitest";
import { ExecApprovalManager, type ExecApprovalRecord } from "./exec-approval-manager.js";
import { sanitizeSystemRunParamsForForwarding } from "./node-invoke-system-run-approval.js";

describe("sanitizeSystemRunParamsForForwarding", () => {
  const now = Date.now();
  const client = {
    connId: "conn-1",
    connect: {
      scopes: ["operator.write", "operator.approvals"],
      device: { id: "dev-1" },
      client: { id: "cli-1" },
    },
  };

  function makeRecord(command: string): ExecApprovalRecord {
    return {
      id: "approval-1",
      request: {
        host: "node",
        nodeId: "node-1",
        command,
        cwd: null,
        agentId: null,
        sessionKey: null,
      },
      createdAtMs: now - 1_000,
      expiresAtMs: now + 60_000,
      requestedByConnId: "conn-1",
      requestedByDeviceId: "dev-1",
      requestedByClientId: "cli-1",
      resolvedAtMs: now - 500,
      decision: "allow-once",
      resolvedBy: "operator",
    };
  }

  function manager(record: ReturnType<typeof makeRecord>) {
    let consumed = false;
    return {
      getSnapshot: () => record,
      consumeAllowOnce: () => {
        if (consumed || record.decision !== "allow-once") {
          return false;
        }
        consumed = true;
        record.decision = undefined;
        return true;
      },
    };
  }

  function expectAllowOnceForwardingResult(
    result: ReturnType<typeof sanitizeSystemRunParamsForForwarding>,
  ) {
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    const params = result.params as Record<string, unknown>;
    expect(params.approved).toBe(true);
    expect(params.approvalDecision).toBe("allow-once");
  }

  test("rejects cmd.exe /c trailing-arg mismatch against rawCommand", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["cmd.exe", "/d", "/s", "/c", "echo", "SAFE&&whoami"],
        rawCommand: "echo",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(makeRecord("echo")),
      nowMs: now,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.message).toContain("rawCommand does not match command");
    expect(result.details?.code).toBe("RAW_COMMAND_MISMATCH");
  });

  test("accepts matching cmd.exe /c command text for approval binding", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["cmd.exe", "/d", "/s", "/c", "echo", "SAFE&&whoami"],
        rawCommand: "echo SAFE&&whoami",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(makeRecord("echo SAFE&&whoami")),
      nowMs: now,
    });
    expectAllowOnceForwardingResult(result);
  });

  test("rejects env-assignment shell wrapper when approval command omits env prelude", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo SAFE"],
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(makeRecord("echo SAFE")),
      nowMs: now,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.message).toContain("approval id does not match request");
    expect(result.details?.code).toBe("APPROVAL_REQUEST_MISMATCH");
  });

  test("accepts env-assignment shell wrapper only when approval command matches full argv text", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo SAFE"],
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(
        makeRecord('/usr/bin/env BASH_ENV=/tmp/payload.sh bash -lc "echo SAFE"'),
      ),
      nowMs: now,
    });
    expectAllowOnceForwardingResult(result);
  });
  test("consumes allow-once approvals and blocks same runId replay", async () => {
    const approvalManager = new ExecApprovalManager();
    const runId = "approval-replay-1";
    const record = approvalManager.create(
      {
        host: "node",
        nodeId: "node-1",
        command: "echo SAFE",
        cwd: null,
        agentId: null,
        sessionKey: null,
      },
      60_000,
      runId,
    );
    record.requestedByConnId = "conn-1";
    record.requestedByDeviceId = "dev-1";
    record.requestedByClientId = "cli-1";

    const decisionPromise = approvalManager.register(record, 60_000);
    approvalManager.resolve(runId, "allow-once", "operator");
    await expect(decisionPromise).resolves.toBe("allow-once");

    const params = {
      command: ["echo", "SAFE"],
      rawCommand: "echo SAFE",
      runId,
      approved: true,
      approvalDecision: "allow-once",
    };

    const first = sanitizeSystemRunParamsForForwarding({
      nodeId: "node-1",
      rawParams: params,
      client,
      execApprovalManager: approvalManager,
      nowMs: now,
    });
    expectAllowOnceForwardingResult(first);

    const second = sanitizeSystemRunParamsForForwarding({
      nodeId: "node-1",
      rawParams: params,
      client,
      execApprovalManager: approvalManager,
      nowMs: now,
    });
    expect(second.ok).toBe(false);
    if (second.ok) {
      throw new Error("unreachable");
    }
    expect(second.details?.code).toBe("APPROVAL_REQUIRED");
  });

  test("rejects approval ids that do not bind a nodeId", () => {
    const record = makeRecord("echo SAFE");
    record.request.nodeId = null;
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(record),
      nowMs: now,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.message).toContain("missing node binding");
    expect(result.details?.code).toBe("APPROVAL_NODE_BINDING_MISSING");
  });

  test("rejects approval ids replayed against a different nodeId", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-2",
      client,
      execApprovalManager: manager(makeRecord("echo SAFE")),
      nowMs: now,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.message).toContain("not valid for this node");
    expect(result.details?.code).toBe("APPROVAL_NODE_MISMATCH");
  });
});
