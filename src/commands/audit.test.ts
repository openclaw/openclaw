import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import type { RuntimeEnv } from "../runtime.js";
import { auditListCommand, type AuditListCommandOptions } from "./audit.js";

const callGateway = vi.hoisted(() => vi.fn());
vi.mock("../gateway/call.js", () => ({ callGateway }));

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const list = (options: AuditListCommandOptions) => auditListCommand(options, runtime);

function gatewayError(message: string) {
  return Object.assign(new Error(message), {
    name: "GatewayClientRequestError",
    gatewayCode: "INVALID_REQUEST",
  });
}

function expectRequests(...requests: Array<[string, object]>) {
  expect(callGateway.mock.calls).toEqual(requests.map(([method, params]) => [{ method, params }]));
}

function unknownInspection(missing = "identity.context") {
  return {
    schemaVersion: 1,
    run: { runId: "run-1", executionId: "execution-1", status: "unknown" },
    identity: {
      state: "unknown",
      reasonCode: "execution_not_found",
      missingEvidence: [missing],
      remediation: [],
    },
    decisionDisplays: [],
    coverage: { state: "unknown", missingEvidence: [missing] },
  };
}

const output = () => vi.mocked(runtime.log).mock.calls.flat().join("\n");

beforeEach(() => {
  callGateway.mockReset();
  callGateway.mockResolvedValue({ events: [] });
  for (const writer of [runtime.log, runtime.error, runtime.exit]) {
    vi.mocked(writer).mockClear();
  }
});

describe("audit command parsing", () => {
  it("converts ISO and millisecond timestamps before querying the Gateway", async () => {
    await list({ after: "1234", before: "2024-02-29T00:00:00Z" });

    expectRequests([
      "audit.activity.list",
      {
        limit: 100,
        after: 1234,
        before: Date.parse("2024-02-29T00:00:00Z"),
      },
    ]);
  });

  it.each([
    { flag: "--after", options: { after: "2026-02-30T00:00:00Z" } },
    { flag: "--before", options: { before: "July 1, 2026" } },
    { flag: "--after", options: { after: "" } },
  ])("rejects invalid $flag before calling the Gateway", async ({ flag, options }) => {
    await expect(list(options)).rejects.toThrow(flag);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("preserves the local-time result for timezone-less timestamps", async () => {
    const input = "2026-07-01T00:00:00";
    const localMs = 1_782_878_400_000;
    const utcMs = 1_782_864_000_000;
    const parsed = new Map([
      [input, localMs],
      [`${input}Z`, utcMs],
    ]);
    const parse = vi
      .spyOn(Date, "parse")
      .mockImplementation((value) => parsed.get(value) ?? Number.NaN);

    try {
      await list({ after: input });
      expectRequests(["audit.activity.list", { limit: 100, after: localMs }]);
    } finally {
      parse.mockRestore();
    }
  });

  it("enforces the list export bound before querying the Gateway", async () => {
    await list({ limit: "500" });
    expectRequests(["audit.activity.list", { limit: 500 }]);

    callGateway.mockClear();
    await expect(list({ limit: "501" })).rejects.toThrow("1 and 500");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      options: { direction: "sideways" as never },
      message: "--direction must be inbound or outbound.",
    },
    {
      options: { kind: "message" as const, sessionKey: "agent:main:main" },
      message: "--session only applies to --kind agent_run or tool_action.",
    },
    {
      options: { sessionKey: "agent:main:main", direction: "inbound" as const },
      message: "--direction cannot be combined with --session.",
    },
  ])("rejects invalid audit filters before querying the Gateway", async ({ options, message }) => {
    await runCommandWithRuntime(runtime, () => list({ ...options, limit: "10" }));
    expect(runtime.error).toHaveBeenCalledWith(message);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("renders activity safely without inventing message provenance", async () => {
    callGateway.mockResolvedValue({
      events: [
        {
          occurredAt: 0,
          kind: "tool_action",
          action: "tool.action.finished",
          status: "failed",
          agentId: "main\nforged",
          runId: "run\tcolumn",
          toolName: "\u001b]8;;https://example.invalid\u0007unsafe",
        },
        {
          occurredAt: 0,
          kind: "message",
          action: "message.inbound.processed",
          status: "succeeded",
          direction: "inbound",
          channel: "telegram",
        },
        {
          occurredAt: 0,
          kind: "tool_action",
          action: "tool.action.finished",
          status: "failed",
          agentId: `${"x".repeat(16)}🚀tail`,
        },
      ],
    });

    await list({});
    const [header, unsafeRow, messageRow, truncatedRow] = vi
      .mocked(runtime.log)
      .mock.calls.map(([line]) => line);

    expect(header).toContain("DIRECTION\tCHANNEL");
    expect(unsafeRow).not.toContain("\n");
    expect(unsafeRow).not.toContain("\u001b");
    expect(unsafeRow).toContain("main\\nforged");
    expect(unsafeRow).toContain("run\\tcolumn");
    expect(messageRow).toContain("message\tinbound\ttelegram\tsucceeded\t-\t-");
    expect(truncatedRow).toContain(`${"x".repeat(16)}…`);
    expect(truncatedRow).not.toContain("\uD83D");
  });
});

describe("audit command gateway compatibility", () => {
  it("forwards valid filters unchanged and keeps an empty page successful", async () => {
    const options = {
      agentId: "main",
      kind: "message",
      status: "failed",
      direction: "inbound",
      channel: "telegram",
      after: "100",
      before: "200",
      cursor: "42",
      limit: "25",
    } satisfies AuditListCommandOptions;
    const params = { ...options, limit: 25, after: 100, before: 200 };
    await runCommandWithRuntime(runtime, () => list(options));

    expect(callGateway).toHaveBeenCalledTimes(1);
    expectRequests(["audit.activity.list", params]);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("falls back to audit.list only with legacy-compatible filters", async () => {
    callGateway
      .mockRejectedValueOnce(gatewayError("unknown method: audit.activity.list"))
      .mockResolvedValueOnce({
        events: [],
        nextCursor: "8",
      });

    const options = {
      agentId: "main",
      sessionKey: "agent:main:main",
      runId: "run-1",
      kind: "tool_action" as const,
      status: "failed" as const,
      after: "100",
      before: "200",
      cursor: "9",
      limit: "25",
    };
    const params = { ...options, limit: 25, after: 100, before: 200 };
    await list(options);
    expectRequests(["audit.activity.list", params], ["audit.list", params]);
  });

  it("falls back when an old gateway authorizes an unknown method as admin", async () => {
    callGateway
      .mockRejectedValueOnce(gatewayError("missing scope: operator.admin"))
      .mockResolvedValueOnce({
        events: [],
      });

    await list({ limit: "10" });

    expect(callGateway).toHaveBeenNthCalledWith(2, {
      method: "audit.list",
      params: { limit: 10 },
    });
  });

  it("fails clearly instead of dropping message-specific filters on old gateways", async () => {
    callGateway.mockRejectedValueOnce(gatewayError("unknown method: audit.activity.list"));

    await expect(list({ direction: "inbound", limit: "10" })).rejects.toThrow(
      "does not support message audit filters",
    );
    expect(callGateway).toHaveBeenCalledTimes(1);
  });

  it.each<[string, AuditListCommandOptions, string, string]>([
    [
      "invalid audit activity params",
      { limit: "10" },
      "invalid audit activity params",
      "GatewayClientRequestError",
    ],
    [
      "invalid audit.activity.list range or cursor",
      { cursor: "abc" },
      "--cursor must be a continuation token returned by a previous audit result.",
      "audit.activity.list",
    ],
  ])("renders an actionable Gateway error: %s", async (message, options, expected, omitted) => {
    callGateway.mockRejectedValueOnce(gatewayError(message));
    await runCommandWithRuntime(runtime, () => list(options));
    expect(runtime.error).toHaveBeenCalledWith(expected);
    expect(String(vi.mocked(runtime.error).mock.calls[0]?.[0])).not.toContain(omitted);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(callGateway).toHaveBeenCalledTimes(1);
  });
});

describe("audit run explanation", () => {
  it.each<[AuditListCommandOptions, string]>([
    [{ executionId: "execution-1" }, "--execution requires --explain"],
    [{ explain: true }, "exactly one of --run <id> or --execution <id>"],
    [{ explain: true, runId: "run-1", executionId: "execution-1" }, "exactly one"],
    [{ explain: true, runId: "run-1", agentId: "main" }, "remove activity-list filters"],
    [{ limit: "" }, "1 and 500"],
    [{ explain: true, runId: "run-1", limit: "" }, "with --explain"],
  ])("rejects invalid selectors and limits before the Gateway: %j", async (options, message) => {
    await expect(list(options)).rejects.toThrow(message);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("keeps decision and run discovery queries bounded", async () => {
    callGateway.mockResolvedValue(unknownInspection("run.record"));

    await list({ explain: true, runId: "run-1", json: true });
    await list({ explain: true, executionId: "execution-1", limit: "100", json: true });
    await list({ explain: true, runId: "run-1", limit: "100", json: true });

    expectRequests(
      ["audit.run.inspect", { runId: "run-1", executionLimit: 50, decisionLimit: 50 }],
      ["audit.run.inspect", { executionId: "execution-1", decisionLimit: 100 }],
      ["audit.run.inspect", { runId: "run-1", executionLimit: 50, decisionLimit: 100 }],
    );

    callGateway.mockClear();
    await expect(list({ explain: true, executionId: "execution-1", limit: "101" })).rejects.toThrow(
      "with --explain",
    );
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("queries audit.run.inspect and renders all identity fields with explicit state", async () => {
    const hmacRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;
    const display = {
      schemaVersion: 1,
      enforcement: {
        coverageState: "unknown",
        policyCount: 0,
        grantCount: 0,
        contextFieldsUsed: [],
      },
      missingEvidence: [],
      remediation: [],
    };
    callGateway.mockResolvedValue({
      schemaVersion: 1,
      run: { runId: "run-1", executionId: "execution-1", status: "known" },
      identity: {
        state: "present",
        context: {
          schemaVersion: 1,
          contextId: "context-1",
          executionId: "execution-1",
          runId: "run-1",
          createdAt: 1,
          trustDomain: { kind: "gateway-cell", domainRef: hmacRef, state: "present" },
          invoker: { state: "absent" },
          ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
          agentPrincipal: { kind: "agent", domainRef: hmacRef, principalRef: "main" },
          agentDefinition: { definitionRef: "main", state: "present" },
          runtimeInstance: { runtimeRef: hmacRef, kind: "embedded", state: "present" },
          applicableGrants: [],
          assurance: [
            {
              kind: "runtime-binding",
              evidenceRef: hmacRef,
              strength: "boundary-verified",
            },
          ],
          lineage: {
            parentContextId: "parent-context",
            parentExecutionId: "parent-execution",
            parentRunId: "parent-run",
            parentAgentPrincipal: {
              kind: "agent",
              domainRef: hmacRef,
              principalRef: "parent-agent",
            },
            delegationRef: hmacRef,
            depth: 2,
          },
          coverageState: "unattributed",
          missingEvidence: ["invoker.principal"],
        },
      },
      decisionDisplays: [
        {
          ...display,
          selectorId: "context-1:admission",
          occurredAt: 1,
          action: { family: "run", operation: "admission" },
          decision: {
            outcome: "not-applicable",
            reasonCode: "run_admission_identity_not_evaluated",
          },
          enforcement: { ...display.enforcement, coverageState: "unattributed" },
          provenance: { state: "verified", producer: "run-admission" },
          missingEvidence: ["invoker.principal"],
          remediation: [{ code: "no_claim", text: "Treat this receipt as attribution only." }],
        },
        {
          ...display,
          selectorId: "approval-decision:1",
          occurredAt: 2,
          action: { family: "exec", operation: "approval" },
          decision: {
            outcome: "denied",
            reasonCode: "operator_approval_denied_by_reviewer",
          },
          enforcement: {
            ...display.enforcement,
            coverageState: "enforced",
            policyCount: 1,
            contextFieldsUsed: ["contextId", "executionId", "runId"],
          },
          provenance: { state: "verified", producer: "operator-approval" },
          remediation: [{ code: "review_and_request_again", text: "Review the denial and retry." }],
        },
        {
          ...display,
          selectorId: "decision-fact:1",
          occurredAt: 3,
          action: { family: "decision", operation: "record" },
          decision: { outcome: "unknown", reasonCode: "decision_fact_display_unverified" },
          provenance: { state: "unverified" },
          missingEvidence: ["decision.display_provenance"],
        },
      ],
      coverage: { state: "enforced", missingEvidence: ["invoker.principal"] },
    });

    await list({ explain: true, runId: "run-1", cursor: "1", limit: "25" });

    expectRequests([
      "audit.run.inspect",
      {
        runId: "run-1",
        executionCursor: "1",
        executionLimit: 25,
        decisionCursor: "1",
        decisionLimit: 25,
      },
    ]);
    const text = output();
    for (const label of [
      "Trust domain [present]",
      "Invoker [absent]",
      "Ingress [present]",
      "Agent principal [present]",
      "Agent definition [present]",
      "Runtime instance [present]",
      "Represented subject [absent]",
      "Sponsor [absent]",
      "Applicable grants [absent]",
      "Assurance [present]",
      "Parent context [present]",
      "Parent execution [present]",
      "Parent run [present]",
      "Parent agent [present]",
      "Delegation [present]",
      "Depth [present]",
      "not-applicable",
      "run_admission_identity_not_evaluated",
      "operator_approval_denied_by_reviewer",
      "authoritative owner-native SQLite record; retained 30 days",
      "admission provenance only; no enforcement decision",
      "Policy refs: 1",
      "Policy refs: 0",
      "Grant refs: 0",
      "Context used: contextId, executionId, runId",
      "producer display contract unverified; receipt prose omitted",
    ]) {
      expect(text).toContain(label);
    }
    expect(text).not.toContain("named authoritative decision source");
    vi.mocked(runtime.log).mockClear();
    await list({ explain: true, runId: "run-1", json: true });
    const jsonOutput = output();
    expect(jsonOutput).toContain('"decisionDisplays"');
    expect(jsonOutput).not.toContain('"decisions"');
    for (const rawKey of ["receiptId", "resolutionRef", "eventId"]) {
      expect(jsonOutput).not.toContain(`"${rawKey}"`);
    }
  });

  it("renders ambiguous run discovery and selects an exact execution", async () => {
    callGateway.mockResolvedValueOnce({
      schemaVersion: 1,
      run: { runId: "session-run", status: "known" },
      identity: {
        state: "ambiguous",
        reasonCode: "execution_selection_required",
        candidates: [
          { executionId: "execution-1", contextId: "context-1", createdAt: 1 },
          { executionId: "execution-2", contextId: "context-2", createdAt: 2 },
        ],
        missingEvidence: ["execution.selection"],
        remediation: [
          {
            code: "select_execution_id",
            text: "Select one candidate with openclaw audit --execution <id> --explain.",
          },
        ],
      },
      decisionDisplays: [],
      coverage: { state: "unknown", missingEvidence: ["execution.selection"] },
    });

    await list({ explain: true, runId: "session-run" });
    expect(output()).toContain("Candidate: execution-1");
    expect(output()).toContain("--execution <id> --explain");

    callGateway.mockReset();
    callGateway.mockResolvedValue(unknownInspection());
    await list({ explain: true, executionId: "execution-2", json: true });
    expectRequests(["audit.run.inspect", { executionId: "execution-2", decisionLimit: 50 }]);
  });

  it("routes the shared explain cursor by selector and grammar", async () => {
    callGateway.mockResolvedValue(unknownInspection());

    for (const [selector, cursor, execution] of [
      [{ runId: "run-1" }, "a:2000:42", { executionLimit: 50 }],
      [{ executionId: "execution-1" }, "1", {}],
      [{ runId: "run-1" }, "001", { executionLimit: 50, executionCursor: "001" }],
      [{ executionId: "execution-1" }, "g:2000:42", {}],
    ] as const) {
      callGateway.mockClear();
      await list({ explain: true, ...selector, cursor });
      expect(callGateway).toHaveBeenCalledWith({
        method: "audit.run.inspect",
        params: { ...selector, ...execution, decisionCursor: cursor, decisionLimit: 50 },
      });
    }
  });

  it("returns an explicit upgrade state from an older Gateway", async () => {
    callGateway.mockRejectedValue(gatewayError("unknown method: audit.run.inspect"));

    await list({ explain: true, runId: "old-run", json: true });

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(output()).toContain('"state": "unsupported"');
    expect(output()).toContain("gateway_upgrade_required");
    expect(output()).toContain("upgrade_gateway");
  });
});
