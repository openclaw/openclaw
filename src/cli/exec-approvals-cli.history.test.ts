import { Command } from "commander";
// Approval history CLI coverage stays separate from pending/resolve and policy-management tests.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerExecApprovalsCli } from "./exec-approvals-cli.js";

const mocks = vi.hoisted(() => {
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  const defaultRuntime = {
    log: vi.fn(),
    error: vi.fn((...args: unknown[]) => {
      runtimeErrors.push(stringifyArgs(args));
    }),
    writeStdout: vi.fn((value: string) => {
      defaultRuntime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      defaultRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    callGatewayFromCli: vi.fn(),
    defaultRuntime,
    runtimeErrors,
  };
});

const { callGatewayFromCli, defaultRuntime, runtimeErrors } = mocks;

const requireRecord = createRequireRecord("record", "expected-label-capitalized");

function firstMockArg(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): unknown {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("Expected mock to have at least one call");
  }
  return call[0];
}

function writtenJson(): Record<string, unknown> {
  return requireRecord(firstMockArg(vi.mocked(defaultRuntime.writeJson)), "written json");
}

function runtimeOutput(): string {
  return defaultRuntime.log.mock.calls.map(([line]) => String(line ?? "")).join("\n");
}

const RESOLVED_AT_MS = Date.UTC(2026, 8, 10, 12, 0, 0);

function allowedExecApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-allowed-1",
    status: "allowed",
    decision: "allow-always",
    reason: "user",
    urlPath: "/approve/approval-allowed-1",
    createdAtMs: RESOLVED_AT_MS - 60_000,
    expiresAtMs: RESOLVED_AT_MS + 60_000,
    resolvedAtMs: RESOLVED_AT_MS,
    presentation: {
      kind: "exec",
      commandText: "echo ready",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    source: { agentId: "main", sessionKey: "agent:main:dm" },
    resolver: { kind: "device", id: "device-1" },
    ...overrides,
  };
}

function deniedPluginApproval() {
  return {
    id: "approval-denied-1",
    status: "denied",
    decision: "deny",
    reason: "user",
    urlPath: "/approve/approval-denied-1",
    createdAtMs: RESOLVED_AT_MS - 60_000,
    expiresAtMs: RESOLVED_AT_MS + 60_000,
    resolvedAtMs: RESOLVED_AT_MS,
    presentation: {
      kind: "plugin",
      title: "Send message",
      description: "Post to #general",
      severity: "info",
      allowedDecisions: ["allow-once", "deny"],
    },
    source: { agentId: "helper", sessionKey: "agent:helper:group" },
    resolver: { kind: "channel", id: "telegram:1" },
  };
}

function expiredExecApproval() {
  return {
    id: "approval-expired-1",
    status: "expired",
    reason: "timeout",
    urlPath: "/approve/approval-expired-1",
    createdAtMs: RESOLVED_AT_MS - 60_000,
    expiresAtMs: RESOLVED_AT_MS,
    resolvedAtMs: RESOLVED_AT_MS,
    presentation: {
      kind: "exec",
      commandText: "sleep 1",
      allowedDecisions: ["allow-once", "deny"],
    },
    resolver: { kind: "system" },
  };
}

function cancelledSystemAgentApproval() {
  return {
    id: "approval-cancelled-1",
    status: "cancelled",
    reason: "gateway-restart",
    urlPath: "/approve/approval-cancelled-1",
    createdAtMs: RESOLVED_AT_MS - 60_000,
    expiresAtMs: RESOLVED_AT_MS + 60_000,
    resolvedAtMs: RESOLVED_AT_MS,
    presentation: {
      kind: "system-agent",
      title: "Config change",
      description: "Update gateway config",
      proposalHash: "a".repeat(64),
      allowedDecisions: ["allow-once", "deny"],
    },
  };
}

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
    mocks.callGatewayFromCli(method, opts, params, extra),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

describe("exec approvals history CLI", () => {
  // Wide terminal so table cells stay on one line: these assertions cover cell
  // content, and the table renderer wraps by design on narrow terminals.
  const originalColumns = process.stdout.columns;
  const setWideTerminal = () => {
    Object.defineProperty(process.stdout, "columns", { value: 220, configurable: true });
  };

  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerExecApprovalsCli(program);
    return program;
  };

  const runApprovalsCommand = async (args: string[]) => {
    const program = createProgram();
    await program.parseAsync(args, { from: "user" });
  };

  beforeEach(() => {
    setWideTerminal();
    runtimeErrors.length = 0;
    callGatewayFromCli.mockReset();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", {
      value: originalColumns,
      configurable: true,
    });
  });

  it.each(["tool", "EXEC", "exec ", ""])(
    "rejects an unknown history kind before the Gateway request (%s)",
    async (kind) => {
      await expect(
        runApprovalsCommand(["approvals", "history", "--kind", kind, "--json"]),
      ).rejects.toThrow("--kind must be one of: exec, plugin, system-agent.");

      expect(callGatewayFromCli).not.toHaveBeenCalled();
    },
  );

  it.each(["0", "101", "1.5", "10junk", "-1", "1e2"])(
    "rejects an out-of-range history limit before the Gateway request (%s)",
    async (limit) => {
      await expect(
        runApprovalsCommand(["approvals", "history", "--limit", limit, "--json"]),
      ).rejects.toThrow("--limit must be an integer between 1 and 100.");

      expect(callGatewayFromCli).not.toHaveBeenCalled();
    },
  );

  it("rejects a blank history cursor before the Gateway request", async () => {
    await expect(
      runApprovalsCommand(["approvals", "history", "--cursor", "   ", "--json"]),
    ).rejects.toThrow("--cursor must not be empty.");

    expect(callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("requests the ledger with the approvals scope and no params by default", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ items: [] });

    await runApprovalsCommand(["approvals", "history"]);

    const call = callGatewayFromCli.mock.calls[0];
    expect(call?.[0]).toBe("approval.history");
    expect(call?.[2]).toEqual({});
    expect(call?.[3]).toEqual({ scopes: ["operator.approvals"] });
  });

  it("forwards kind, limit, and cursor exactly as given", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ items: [] });

    await runApprovalsCommand([
      "approvals",
      "history",
      "--kind",
      "system-agent",
      "--limit",
      "100",
      "--cursor",
      "cursor-2",
    ]);

    const call = callGatewayFromCli.mock.calls[0];
    expect(call?.[0]).toBe("approval.history");
    expect(call?.[2]).toEqual({ kind: "system-agent", limit: 100, cursor: "cursor-2" });
  });

  it("writes the Gateway ledger result unchanged with --json", async () => {
    const result = { items: [allowedExecApproval()], nextCursor: "cursor-2" };
    callGatewayFromCli.mockResolvedValueOnce(result);

    await runApprovalsCommand(["approvals", "history", "--json"]);

    expect(writtenJson()).toEqual(result);
  });

  it("renders resolved rows with decision, reason, source, and resolver", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      items: [allowedExecApproval(), deniedPluginApproval()],
    });

    await runApprovalsCommand(["approvals", "history"]);

    const output = runtimeOutput();
    expect(output).toContain("2026-09-10T12:00:00Z");
    expect(output).toContain("echo ready");
    expect(output).toContain("exec");
    expect(output).toContain("allow-always");
    expect(output).toContain("main / agent:main:dm");
    expect(output).toContain("device:device-1");
    expect(output).toContain("Send message: Post to #general");
    expect(output).toContain("plugin");
    expect(output).toContain("deny");
    expect(output).toContain("channel:telegram:1");
  });

  it("shows the terminal status when no reviewer decision was recorded", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      items: [expiredExecApproval(), cancelledSystemAgentApproval()],
    });

    await runApprovalsCommand(["approvals", "history"]);

    const output = runtimeOutput();
    expect(output).toContain("expired");
    expect(output).toContain("timeout");
    expect(output).toContain("cancelled");
    expect(output).toContain("gateway-restart");
    expect(output).toContain("Config change: Update gateway config");
    expect(output).toContain("system-agent");
  });

  it("prints the next cursor so callers can page further back", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      items: [allowedExecApproval()],
      nextCursor: "cursor-page-2",
    });

    await runApprovalsCommand(["approvals", "history"]);

    expect(runtimeOutput()).toContain("cursor-page-2");
  });

  it("carries the active filters in the printed continuation command", async () => {
    // The cursor pins position only; the store reapplies kind/limit per request,
    // so a hint without the filters silently broadens the next page.
    callGatewayFromCli.mockResolvedValueOnce({
      items: [allowedExecApproval()],
      nextCursor: "cursor-page-2",
    });

    await runApprovalsCommand(["approvals", "history", "--kind", "exec", "--limit", "1"]);

    const output = runtimeOutput();
    expect(output).toContain(
      "Page with: openclaw approvals history --cursor cursor-page-2 --kind exec --limit 1",
    );
    expect(output).toContain("reuse your original connection options");
  });

  it("keeps the paging cursor when session-access filtering empties the page", async () => {
    // Visibility filtering runs after pagination, so an empty visible page can
    // still have retained rows behind it; dropping the cursor would dead-end paging.
    callGatewayFromCli.mockResolvedValueOnce({ items: [], nextCursor: "cursor-filtered-page" });

    await runApprovalsCommand(["approvals", "history"]);

    const output = runtimeOutput();
    expect(output).toMatch(/rolling 30-day/);
    expect(output).toContain("cursor-filtered-page");
  });

  it("names the retention window when the ledger has no rows", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ items: [] });

    await runApprovalsCommand(["approvals", "history"]);

    expect(runtimeOutput()).toMatch(/rolling 30-day/);
  });

  it("escapes terminal-unsafe request text instead of emitting raw control bytes", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      items: [
        allowedExecApproval({
          presentation: {
            kind: "exec",
            commandText: "\u001b[31mrm -rf /tmp/x\u001b[0m",
            allowedDecisions: ["allow-once", "deny"],
          },
        }),
      ],
    });

    await runApprovalsCommand(["approvals", "history"]);

    const output = runtimeOutput();
    expect(output).not.toContain("\u001b[31m");
    expect(output).toContain("rm -rf /tmp/x");
  });

  it("rejects an invalid history response", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ items: [{ id: "approval-bogus" }] });

    await expect(runApprovalsCommand(["approvals", "history", "--json"])).rejects.toThrow(
      "Invalid approval history response.",
    );
  });
});
