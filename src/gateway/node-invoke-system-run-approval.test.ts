import { describe, expect, test } from "vitest";
import {
  buildSystemRunApprovalBindingV1,
  buildSystemRunApprovalEnvBinding,
} from "../infra/system-run-approval-binding.js";
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

  function makeRecord(
    command: string,
    commandArgv?: string[],
    bindingArgv?: string[],
  ): ExecApprovalRecord {
    const effectiveBindingArgv = bindingArgv ?? commandArgv ?? [command];
    return {
      id: "approval-1",
      request: {
        host: "node",
        nodeId: "node-1",
        command,
        commandArgv,
        systemRunBindingV1: buildSystemRunApprovalBindingV1({
          argv: effectiveBindingArgv,
          cwd: null,
          agentId: null,
          sessionKey: null,
        }).binding,
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
      execApprovalManager: manager(
        makeRecord("echo SAFE&&whoami", undefined, [
          "cmd.exe",
          "/d",
          "/s",
          "/c",
          "echo",
          "SAFE&&whoami",
        ]),
      ),
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
        makeRecord('/usr/bin/env BASH_ENV=/tmp/payload.sh bash -lc "echo SAFE"', undefined, [
          "/usr/bin/env",
          "BASH_ENV=/tmp/payload.sh",
          "bash",
          "-lc",
          "echo SAFE",
        ]),
      ),
      nowMs: now,
    });
    expectAllowOnceForwardingResult(result);
  });

  test("rejects trailing-space argv mismatch against legacy command-only approval", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["runner "],
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(makeRecord("runner")),
      nowMs: now,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.message).toContain("approval id does not match request");
    expect(result.details?.code).toBe("APPROVAL_REQUEST_MISMATCH");
  });

  test("enforces commandArgv identity when approval includes argv binding", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "SAFE"],
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(makeRecord("echo SAFE", ["echo SAFE"])),
      nowMs: now,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.message).toContain("approval id does not match request");
    expect(result.details?.code).toBe("APPROVAL_REQUEST_MISMATCH");
  });

  test("accepts matching commandArgv binding for trailing-space argv", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["runner "],
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(makeRecord('"runner "', ["runner "])),
      nowMs: now,
    });
    expectAllowOnceForwardingResult(result);
  });

  test("uses systemRunPlanV2 for forwarded command context and ignores caller tampering", () => {
    const record = makeRecord("echo SAFE", ["echo", "SAFE"]);
    record.request.systemRunPlanV2 = {
      version: 2,
      argv: ["/usr/bin/echo", "SAFE"],
      cwd: "/real/cwd",
      rawCommand: "/usr/bin/echo SAFE",
      agentId: "main",
      sessionKey: "agent:main:main",
    };
    record.request.systemRunBindingV1 = buildSystemRunApprovalBindingV1({
      argv: ["/usr/bin/echo", "SAFE"],
      cwd: "/real/cwd",
      agentId: "main",
      sessionKey: "agent:main:main",
    }).binding;
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["echo", "PWNED"],
        rawCommand: "echo PWNED",
        cwd: "/tmp/attacker-link/sub",
        agentId: "attacker",
        sessionKey: "agent:attacker:main",
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(record),
      nowMs: now,
    });
    expectAllowOnceForwardingResult(result);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    const forwarded = result.params as Record<string, unknown>;
    expect(forwarded.command).toEqual(["/usr/bin/echo", "SAFE"]);
    expect(forwarded.rawCommand).toBe("/usr/bin/echo SAFE");
    expect(forwarded.cwd).toBe("/real/cwd");
    expect(forwarded.agentId).toBe("main");
    expect(forwarded.sessionKey).toBe("agent:main:main");
  });

  test("rejects env overrides when approval record lacks env binding", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["git", "diff"],
        rawCommand: "git diff",
        env: { GIT_EXTERNAL_DIFF: "/tmp/pwn.sh" },
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(makeRecord("git diff", ["git", "diff"])),
      nowMs: now,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.details?.code).toBe("APPROVAL_ENV_BINDING_MISSING");
  });

  test("rejects env hash mismatch", () => {
    const record = makeRecord("git diff", ["git", "diff"]);
    record.request.systemRunBindingV1 = {
      version: 1,
      argv: ["git", "diff"],
      cwd: null,
      agentId: null,
      sessionKey: null,
      envHash: buildSystemRunApprovalEnvBinding({ SAFE: "1" }).envHash,
    };
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["git", "diff"],
        rawCommand: "git diff",
        env: { SAFE: "2" },
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
    expect(result.details?.code).toBe("APPROVAL_ENV_MISMATCH");
  });

  test("accepts matching env hash with reordered keys", () => {
    const record = makeRecord("git diff", ["git", "diff"]);
    const binding = buildSystemRunApprovalEnvBinding({ SAFE_A: "1", SAFE_B: "2" });
    record.request.systemRunBindingV1 = {
      version: 1,
      argv: ["git", "diff"],
      cwd: null,
      agentId: null,
      sessionKey: null,
      envHash: binding.envHash,
    };
    const result = sanitizeSystemRunParamsForForwarding({
      rawParams: {
        command: ["git", "diff"],
        rawCommand: "git diff",
        env: { SAFE_B: "2", SAFE_A: "1" },
        runId: "approval-1",
        approved: true,
        approvalDecision: "allow-once",
      },
      nodeId: "node-1",
      client,
      execApprovalManager: manager(record),
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
        commandArgv: ["echo", "SAFE"],
        systemRunBindingV1: buildSystemRunApprovalBindingV1({
          argv: ["echo", "SAFE"],
          cwd: null,
          agentId: null,
          sessionKey: null,
        }).binding,
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
