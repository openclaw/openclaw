import { Command } from "commander";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerExecApprovalsCli } from "./exec-approvals-cli.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return { callGatewayFromCli: vi.fn(), ...createCliRuntimeMock(vi) };
});

const { callGatewayFromCli, defaultRuntime, runtimeErrors, runtimeLogs } = mocks;

const requireRecord = createRequireRecord("record", "expected-label-capitalized");

function writtenJson(): Record<string, unknown> {
  return requireRecord(defaultRuntime.writeJson.mock.calls[0]?.[0], "written json");
}

function runtimeOutput(): string {
  return runtimeLogs.join("\n");
}

function expectOutput(...fragments: string[]) {
  const output = runtimeOutput();
  for (const fragment of fragments) {
    expect(output).toContain(fragment);
  }
}

function pendingEntry(
  id: string,
  request: Record<string, string>,
  createdAgo: number,
  expiresIn = 60_000,
) {
  const now = Date.now();
  return { id, request, createdAtMs: now - createdAgo, expiresAtMs: now + expiresIn };
}

const resolveArgs = (id: string, decision: string, ...options: string[]) => [
  "approvals",
  "resolve",
  id,
  decision,
  ...options,
];

function approvalDisplayId(id: string): string {
  return /^[A-Za-z0-9._:][A-Za-z0-9._:-]{0,127}$/.test(id)
    ? id
    : `id64_${Buffer.from(id, "utf16le").toString("base64url")}`;
}

function pendingApprovalSnapshot(params: {
  id: string;
  kind?: "exec" | "system-agent";
  allowedDecisions?: string[];
  expiresAtMs?: number;
}) {
  const kind = params.kind ?? "exec";
  return {
    approval: {
      id: params.id,
      status: "pending",
      expiresAtMs: params.expiresAtMs ?? Date.now() + 60_000,
      presentation: {
        kind,
        allowedDecisions: params.allowedDecisions ?? ["allow-once", "allow-always", "deny"],
      },
    },
  };
}

function terminalApprovalSnapshot(params: {
  id: string;
  decision: "allow-once" | "allow-always" | "deny";
  resolverId?: string;
}) {
  return {
    ...pendingApprovalSnapshot({ id: params.id }).approval,
    status: params.decision !== "deny" ? "allowed" : "denied",
    decision: params.decision,
    reason: "user",
    resolvedAtMs: Date.now(),
    resolver: { kind: "device", id: params.resolverId ?? "device-1" },
  };
}

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
    mocks.callGatewayFromCli(method, opts, params, extra),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

function mockResolution(
  id: string,
  decision: "allow-once" | "allow-always" | "deny",
  applied = true,
  resolverId?: string,
) {
  callGatewayFromCli.mockImplementation(async (method: string) =>
    method === "approval.get"
      ? pendingApprovalSnapshot({ id })
      : { applied, approval: terminalApprovalSnapshot({ id, decision, resolverId }) },
  );
}

describe("exec approvals pending and resolve CLI", () => {
  const runApprovalsCommand = async (args: string[]) => {
    const program = new Command();
    program.exitOverride();
    registerExecApprovalsCli(program);
    await program.parseAsync(args, { from: "user" });
  };

  beforeEach(() => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGatewayFromCli.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it.each(["10junk"])(
    "rejects a malformed grants list limit before the Gateway request (%s)",
    async (limit) => {
      await expect(
        runApprovalsCommand(["approvals", "grants", "list", "--limit", limit, "--json"]),
      ).rejects.toThrow("--limit must be a positive integer.");

      expect(callGatewayFromCli).not.toHaveBeenCalled();
    },
  );

  it("forwards a valid grants list limit as a number", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ grants: [] });

    await runApprovalsCommand(["approvals", "grants", "list", "--limit", "25", "--json"]);

    const call = callGatewayFromCli.mock.calls[0];
    expect(call?.[0]).toBe("exec.approval.grants.list");
    expect(call?.[2]).toEqual({ limit: 25 });
  });

  it.each(["10junk", "3651"])(
    "rejects an invalid grant lifetime without resolving the approval (%s)",
    async (expiresInDays) => {
      mockResolution("lifetime-invalid", "allow-always");

      await expect(
        runApprovalsCommand(
          resolveArgs("lifetime-invalid", "allow-always", "--expires-in-days", expiresInDays),
        ),
      ).rejects.toThrow("__exit__:1");

      expect(runtimeErrors).toEqual([
        "--expires-in-days must be a whole number of days between 1 and 3650.",
      ]);
      expect(callGatewayFromCli.mock.calls.map(([method]) => method)).toEqual(["approval.get"]);
    },
  );

  it.each(["3650"])("preserves the maximum grant lifetime (%s)", async (expiresInDays) => {
    mockResolution("lifetime-valid", "allow-always");

    await runApprovalsCommand(
      resolveArgs("lifetime-valid", "allow-always", "--expires-in-days", expiresInDays, "--json"),
    );

    expect(callGatewayFromCli.mock.calls[1]?.[0]).toBe("approval.resolve");
    expect(callGatewayFromCli.mock.calls[1]?.[2]).toEqual({
      id: "lifetime-valid",
      kind: "exec",
      decision: "allow-always",
      grantExpiresInDays: Number(expiresInDays),
    });
    expect(writtenJson()).toMatchObject({ applied: true, alreadyResolved: false });
  });

  it("renders pending approvals from all three approval kinds", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "exec.approval.list") {
        return [
          pendingEntry(
            "exec-\u202E1",
            {
              command: `printf '${"x".repeat(120)}' \u001B]52;c;--osc-hidden-action\u0007 --full-command-tail`,
              agentId: "m\u202Ea",
              sessionKey: "agent:main:discord:dm:1",
            },
            5_000,
          ),
        ];
      }
      if (method === "plugin.approval.list") {
        return [
          pendingEntry(
            "plugin:1",
            {
              title: "Publish package",
              description: "Publish the prepared plugin package",
              agentId: "release",
              sessionKey: "agent:release:main",
            },
            4_000,
            55_000,
          ),
          pendingEntry("plugin:blank", { title: " ", description: "\t" }, 3_500, 54_000),
        ];
      }
      if (method === "openclaw.approval.list") {
        return [
          pendingEntry(
            "system-agent:1",
            {
              title: "OpenClaw change",
              description: "Change the system configuration",
              command: "apply-system-change --force",
              agentId: "main",
              sessionKey: "agent:main:main",
            },
            3_000,
            -500,
          ), // The Gateway list is authoritative despite the CLI clock.
        ];
      }
      return [];
    });

    await runApprovalsCommand(["approvals", "pending"]);

    expect(callGatewayFromCli.mock.calls.map((call) => call[0])).toEqual([
      "exec.approval.list",
      "plugin.approval.list",
      "openclaw.approval.list",
    ]);
    for (const call of callGatewayFromCli.mock.calls) {
      expect(call[3]).toEqual({ scopes: ["operator.admin"] });
    }
    const execDisplayId = approvalDisplayId("exec-\u202E1");
    expectOutput(
      "Pending approvals",
      execDisplayId,
      "m\\u{202E}a",
      approvalDisplayId("plugin:1"),
      approvalDisplayId("system-agent:1"),
      approvalDisplayId("plugin:blank"),
      "Publish package",
      "OpenClaw change: Change the system configuration",
      "\\u{9}",
      "Full request text",
      "--osc-hidden-action",
      "\\u{1B}]52;c;",
      "--full-command-tail",
      "Agent / Session",
      "Expires In",
    );
    // System-agent approvals show only their reviewer-safe presentation; the
    // raw host-local operation must never reach the terminal.
    expect(runtimeOutput()).not.toContain("apply-system-change");
    expect(runtimeErrors).toHaveLength(0);
  });

  it("preserves whitespace-bearing ids verbatim and keeps them distinct", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "exec.approval.list") {
        return [
          pendingEntry(" victim ", { command: "echo padded" }, 2_000),
          pendingEntry("victim", { command: "echo exact" }, 1_000),
          // Ill-formed ids cannot resolve through the unified schema; omit dead tokens.
          pendingEntry("bad-\uD800", { command: "echo surrogate" }, 500),
        ];
      }
      return [];
    });

    await runApprovalsCommand(["approvals", "pending", "--json"]);

    const ids = (writtenJson() as { approvals: { id: string }[] }).approvals.map(
      (entry) => entry.id,
    );
    expect(ids).toContain(" victim ");
    expect(ids).toContain("victim");
    expect(ids).not.toContain("bad-\uD800");
  });

  it("resolves an approval and prints the settled decision and resolver", async () => {
    const approvalId = "approval-\u202E1";
    const displayId = approvalDisplayId(approvalId);
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "approval.get") {
          const requestedId = requireRecord(params, "approval lookup params").id;
          if (requestedId === displayId) {
            throw new Error("approval not found");
          }
          return pendingApprovalSnapshot({ id: approvalId });
        }
        if (method === "approval.resolve") {
          return {
            applied: true,
            approval: terminalApprovalSnapshot({
              id: approvalId,
              decision: "allow-once",
              resolverId: "device-\u202E1",
            }),
          };
        }
        return {};
      },
    );

    await runApprovalsCommand(
      resolveArgs(
        displayId,
        "allow-once",
        "--url",
        "ws://127.0.0.1:18789",
        "--token",
        "test-token",
      ),
    );

    expect(callGatewayFromCli.mock.calls[2]?.[0]).toBe("approval.resolve");
    expect(callGatewayFromCli.mock.calls[2]?.[2]).toEqual({
      id: approvalId,
      kind: "exec",
      decision: "allow-once",
    });
    for (const call of callGatewayFromCli.mock.calls) {
      expect(call[3]).toEqual({
        scopes: ["operator.admin", "operator.approvals"],
      });
    }
    expect(runtimeOutput()).toContain(
      `Approval ${displayId} resolved allow-once by device:device-\\u{202E}1`,
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("treats an already-resolved same decision as idempotent success", async () => {
    const approvalId = "job\\u{41}";
    mockResolution(approvalId, "deny", false, "other-device");

    await runApprovalsCommand(resolveArgs(approvalId, "deny"));

    expect(callGatewayFromCli.mock.calls[0]?.[2]).toEqual({ id: approvalId });
    expect(callGatewayFromCli.mock.calls[1]?.[2]).toMatchObject({ id: approvalId });
    expect(runtimeOutput()).toContain("already resolved (same decision: deny)");
    expect(runtimeOutput()).toContain("device:other-device");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("rejects an id token that also exists as a raw approval id", async () => {
    // Explicit token form: the display helper renders safe ids raw, but the
    // resolve path must stay ambiguity-safe for pasted tokens regardless.
    const displayId = `id64_${Buffer.from("foo", "utf16le").toString("base64url")}`;
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method !== "approval.get") {
          throw new Error("resolve must not be called");
        }
        const id = String(requireRecord(params, "approval lookup params").id);
        return pendingApprovalSnapshot({ id });
      },
    );

    await expect(runApprovalsCommand(resolveArgs(displayId, "deny"))).rejects.toThrow("__exit__:1");

    expect(runtimeErrors[0]).toContain("matches both a raw id and a displayed id token");
    expect(callGatewayFromCli).toHaveBeenCalledTimes(2);
  });

  it("exits non-zero when an approval already has a different decision", async () => {
    mockResolution("approval-3", "deny", false);

    await expect(runApprovalsCommand(resolveArgs("approval-3", "allow-once"))).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors[0]).toContain("already resolved with deny by device:device-1");
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("exits non-zero with a bounded, well-formed error when an approval is not found", async () => {
    const prefix = `approval not found: ${"x".repeat(279)}`;
    callGatewayFromCli.mockRejectedValue(new Error(`${prefix}\u{1F680}tail\nignored`));

    await expect(runApprovalsCommand(resolveArgs("missing", "deny"))).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toEqual([`${prefix}...`]);
    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
  });

  it("lets the gateway decide that an approval expired", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "approval.get") {
        return pendingApprovalSnapshot({ id: "expired-1", expiresAtMs: Date.now() - 1 });
      }
      const pending = pendingApprovalSnapshot({ id: "expired-1" }).approval;
      return {
        applied: false,
        approval: {
          ...pending,
          status: "expired",
          reason: "timeout",
          resolvedAtMs: pending.expiresAtMs,
        },
      };
    });

    await expect(runApprovalsCommand(resolveArgs("expired-1", "deny"))).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors[0]).toBe(`Approval ${approvalDisplayId("expired-1")} expired.`);
    expect(callGatewayFromCli).toHaveBeenCalledTimes(2);
  });

  it("rejects decisions unavailable for the approval kind", async () => {
    callGatewayFromCli.mockResolvedValueOnce(
      pendingApprovalSnapshot({
        id: "system-agent:2",
        kind: "system-agent",
        allowedDecisions: ["allow-once", "deny"],
      }),
    );

    await expect(
      runApprovalsCommand(resolveArgs("system-agent:2", "allow-always")),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors[0]).toContain(
      "allow-always is not allowed for system-agent approvals; allowed decisions: allow-once, deny",
    );
    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
  });

  it("escapes hostile grant fields visibly in the standing-grant ledger", async () => {
    const now = Date.now();
    callGatewayFromCli.mockResolvedValueOnce({
      grants: [
        {
          grantId: "grant-1",
          cronJobId: "job-1",
          cronJobName: "night\u001B[2Jly",
          command: "echo hi \u001B]52;c;steal\u0007",
          cwd: null,
          createdAtMs: now - 60_000,
          expiresAtMs: null,
          revokedAtMs: now - 1_000,
          revokedBy: "ops\u001B[1;31madmin",
          lastUsedAtMs: null,
          useCount: 3,
        },
      ],
    });

    await runApprovalsCommand(["approvals", "grants", "list"]);

    const output = runtimeOutput();
    expect(output).not.toContain("\u001B");
    expectOutput("revoked by ops\\u{1B}", "night\\u{1B}", "\\u{1B}]52;c;steal");
  });
});
