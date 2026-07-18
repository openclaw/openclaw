// Exec approvals CLI tests cover approval command registration and output handling.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SESSION_EXEC_OVERRIDES_NOTE } from "../infra/exec-approvals-effective.js";
import * as execApprovals from "../infra/exec-approvals.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals.js";
import { registerExecApprovalsCli, testing } from "./exec-approvals-cli.js";

describe("exec approvals CLI error formatting", () => {
  it("keeps the bounded first line UTF-16 well-formed", () => {
    const message = testing.formatCliError(`${"x".repeat(299)}🚀tail\nignored`);

    expect(message).toBe(`${"x".repeat(299)}...`);
  });
});

const mocks = vi.hoisted(() => {
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  const readBestEffortConfig = vi.fn(async () => ({}));
  const loadOrCreateDeviceIdentity = vi.fn(() => ({ deviceId: "cli-device" }));
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
    callGatewayFromCli: vi.fn(
      async (
        method: string,
        _opts: unknown,
        params?: unknown,
        _extra?: unknown,
      ): Promise<unknown> => {
        if (method.endsWith(".get")) {
          if (method === "config.get") {
            return {
              config: {
                tools: {
                  exec: {
                    security: "full",
                    ask: "off",
                  },
                },
              },
            };
          }
          const snapshot = {
            path: "/tmp/exec-approvals.json",
            exists: true,
            hash: "hash-1",
            file: { version: 1, agents: {} },
          };
          return method === "exec.approvals.node.get"
            ? {
                ...snapshot,
                resolvedDefaults: {
                  security: "allowlist" as const,
                  ask: "on-miss" as const,
                  askFallback: "deny" as const,
                  autoAllowSkills: false,
                },
              }
            : snapshot;
        }
        return { method, params };
      },
    ),
    defaultRuntime,
    loadOrCreateDeviceIdentity,
    readBestEffortConfig,
    runtimeErrors,
  };
});

const {
  callGatewayFromCli,
  defaultRuntime,
  loadOrCreateDeviceIdentity,
  readBestEffortConfig,
  runtimeErrors,
} = mocks;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const localSnapshot = {
  path: "/tmp/local-exec-approvals.json",
  exists: true,
  raw: "{}",
  hash: "hash-local",
  file: { version: 1, agents: {} } as ExecApprovalsFile,
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

function expectFields(
  value: unknown,
  label: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expected] of Object.entries(fields)) {
    expect(record[key]).toEqual(expected);
  }
  return record;
}

function firstMockArg(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): unknown {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("Expected mock to have at least one call");
  }
  return call[0];
}

function gatewayCall(index: number) {
  const call = callGatewayFromCli.mock.calls[index];
  if (!call) {
    throw new Error(`Expected gateway call ${index + 1}`);
  }
  return call;
}

function expectGatewayCall(index: number, method: string, params: unknown) {
  const call = gatewayCall(index);
  expect(call[0]).toBe(method);
  expect(requireRecord(call[1], "gateway call options").timeout).toBe("60000");
  expect(call[2]).toEqual(params);
}

function writtenJson(): Record<string, unknown> {
  const value = firstMockArg(vi.mocked(defaultRuntime.writeJson));
  return requireRecord(value, "written json");
}

function runtimeOutput(): string {
  return defaultRuntime.log.mock.calls.map(([line]) => String(line ?? "")).join("\n");
}

function approvalDisplayId(id: string): string {
  // Mirrors the CLI: terminal-safe ids render raw; only unsafe ids get the
  // copyable id64 token.
  return /^[A-Za-z0-9._:-]{1,128}$/.test(id)
    ? id
    : `id64_${Buffer.from(id).toString("base64url")}`;
}

function pendingApprovalSnapshot(params: {
  id: string;
  kind?: "exec" | "plugin" | "system-agent";
  allowedDecisions?: string[];
  expiresAtMs?: number;
}) {
  const kind = params.kind ?? "exec";
  return {
    approval: {
      id: params.id,
      status: "pending",
      urlPath: `/approve/${params.id}`,
      createdAtMs: Date.now() - 1_000,
      expiresAtMs: params.expiresAtMs ?? Date.now() + 60_000,
      presentation:
        kind === "exec"
          ? {
              kind,
              commandText: "echo ready",
              allowedDecisions: params.allowedDecisions ?? ["allow-once", "allow-always", "deny"],
            }
          : {
              kind,
              title: kind === "plugin" ? "Plugin action" : "OpenClaw change",
              description: "Apply the requested change",
              ...(kind === "plugin" ? { severity: "warning" } : { proposalHash: "a".repeat(64) }),
              allowedDecisions: params.allowedDecisions ?? ["allow-once", "deny"],
            },
    },
  };
}

function terminalApprovalSnapshot(params: {
  id: string;
  decision: "allow-once" | "allow-always" | "deny";
  resolverId?: string;
}) {
  const allowed = params.decision !== "deny";
  return {
    id: params.id,
    status: allowed ? "allowed" : "denied",
    decision: params.decision,
    reason: "user",
    urlPath: `/approve/${params.id}`,
    createdAtMs: Date.now() - 1_000,
    expiresAtMs: Date.now() + 60_000,
    resolvedAtMs: Date.now(),
    presentation: {
      kind: "exec",
      commandText: "echo ready",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    resolver: { kind: "device", id: params.resolverId ?? "device-1" },
  };
}

function effectivePolicy(output: Record<string, unknown> = writtenJson()) {
  return requireRecord(output.effectivePolicy, "effective policy");
}

function scopes(output: Record<string, unknown> = writtenJson()) {
  return requireArray(effectivePolicy(output).scopes, "effective policy scopes");
}

function scopeByLabel(label: string, output: Record<string, unknown> = writtenJson()) {
  const scope = scopes(output).find(
    (entry) => requireRecord(entry, "policy scope").scopeLabel === label,
  );
  if (!scope) {
    throw new Error(`Expected policy scope ${label}`);
  }
  return requireRecord(scope, `policy scope ${label}`);
}

function resetLocalSnapshot() {
  localSnapshot.hash = "hash-local";
  localSnapshot.file = { version: 1, agents: {} };
}

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
    mocks.callGatewayFromCli(method, opts, params, extra),
}));

vi.mock("../infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: () => mocks.loadOrCreateDeviceIdentity(),
}));

vi.mock("./nodes-cli/rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./nodes-cli/rpc.js")>("./nodes-cli/rpc.js");
  return {
    ...actual,
    resolveNodeId: vi.fn(async () => "node-1"),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    readBestEffortConfig: mocks.readBestEffortConfig,
  };
});

vi.mock("../infra/exec-approvals.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  return {
    ...actual,
    readExecApprovalsSnapshot: () => localSnapshot,
    updateExecApprovals: vi.fn(
      async ({
        baseHash,
        update,
      }: {
        baseHash?: string;
        update: (file: ExecApprovalsFile) => ExecApprovalsFile | null;
      }) => {
        if (baseHash !== undefined && baseHash !== localSnapshot.hash) {
          return null;
        }
        const next = update(structuredClone(localSnapshot.file));
        if (next !== null) {
          localSnapshot.file = next;
          localSnapshot.hash = "hash-local-written";
        }
        return structuredClone(localSnapshot);
      },
    ),
  };
});

describe("exec approvals CLI", () => {
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

  const runNativeApprovalsFileCommand = async (filePath: string) => {
    callGatewayFromCli.mockResolvedValue({
      enabled: true,
      hash: "sha256:current",
      defaultAction: "deny",
      rules: [],
    } as never);
    await runApprovalsCommand([
      "approvals",
      "set",
      "--node",
      "windows",
      "--file",
      filePath,
      "--json",
    ]);
  };

  beforeEach(() => {
    resetLocalSnapshot();
    runtimeErrors.length = 0;
    callGatewayFromCli.mockClear();
    loadOrCreateDeviceIdentity.mockReset();
    loadOrCreateDeviceIdentity.mockReturnValue({ deviceId: "cli-device" });
    readBestEffortConfig.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it("routes get command to local, gateway, and node modes", async () => {
    await runApprovalsCommand(["approvals", "get"]);

    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(readBestEffortConfig).toHaveBeenCalledTimes(1);
    expect(
      defaultRuntime.log.mock.calls.filter(([line]) =>
        String(line ?? "").includes(SESSION_EXEC_OVERRIDES_NOTE),
      ),
    ).toHaveLength(1);
    expect(runtimeErrors).toHaveLength(0);
    callGatewayFromCli.mockClear();
    defaultRuntime.log.mockClear();

    await runApprovalsCommand(["approvals", "get", "--gateway"]);

    expectGatewayCall(0, "exec.approvals.get", {});
    expectGatewayCall(1, "config.get", {});
    expect(
      defaultRuntime.log.mock.calls.filter(([line]) =>
        String(line ?? "").includes(SESSION_EXEC_OVERRIDES_NOTE),
      ),
    ).toHaveLength(1);
    expect(runtimeErrors).toHaveLength(0);
    callGatewayFromCli.mockClear();
    defaultRuntime.log.mockClear();

    await runApprovalsCommand(["approvals", "get", "--node", "macbook"]);

    expectGatewayCall(0, "exec.approvals.node.get", { nodeId: "node-1" });
    expectGatewayCall(1, "config.get", {});
    expect(
      defaultRuntime.log.mock.calls.filter(([line]) =>
        String(line ?? "").includes(SESSION_EXEC_OVERRIDES_NOTE),
      ),
    ).toHaveLength(1);
    expect(runtimeErrors).toHaveLength(0);
  });

  it("renders pending approvals from all three approval kinds", async () => {
    const now = Date.now();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "exec.approval.list") {
        return [
          {
            id: "exec-\u202E1",
            request: {
              command: `printf '${"x".repeat(120)}' \u001B]52;c;--osc-hidden-action\u0007 --full-command-tail`,
              agentId: "m\u202Ea",
              sessionKey: "agent:main:discord:dm:1",
            },
            createdAtMs: now - 5_000,
            expiresAtMs: now + 60_000,
          },
        ];
      }
      if (method === "plugin.approval.list") {
        return [
          {
            id: "plugin:1",
            request: {
              title: "Publish package",
              description: "Publish the prepared plugin package",
              agentId: "release",
              sessionKey: "agent:release:main",
            },
            createdAtMs: now - 4_000,
            expiresAtMs: now + 55_000,
          },
          {
            id: "plugin:blank",
            request: { title: " ", description: "\t" },
            createdAtMs: now - 3_500,
            expiresAtMs: now + 54_000,
          },
        ];
      }
      if (method === "openclaw.approval.list") {
        return [
          {
            id: "system-agent:1",
            request: {
              title: "OpenClaw change",
              description: "Change the system configuration",
              command: "apply-system-change --force",
              agentId: "main",
              sessionKey: "agent:main:main",
            },
            createdAtMs: now - 3_000,
            // The Gateway list is authoritative even when the CLI clock is ahead.
            expiresAtMs: now - 500,
          },
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
    const output = runtimeOutput();
    const execDisplayId = approvalDisplayId("exec-\u202E1");
    expect(output).toContain("Pending approvals");
    expect(output).toContain(execDisplayId);
    expect(output).toContain("m\\u{202E}a");
    expect(output).toContain(approvalDisplayId("plugin:1"));
    expect(output).toContain(approvalDisplayId("system-agent:1"));
    expect(output).toContain(approvalDisplayId("plugin:blank"));
    expect(output).toContain("Publish package");
    expect(output).toContain("Command: apply-system-change --force");
    expect(output).toContain("\\u{9}");
    expect(output).toContain("Full request text");
    expect(output).toContain("--osc-hidden-action");
    expect(output).toContain("\\u{1B}]52;c;");
    expect(output).toContain("--full-command-tail");
    expect(output).toContain("Agent / Session");
    expect(output).toContain("Expires In");
    expect(runtimeErrors).toHaveLength(0);
  });

  it("writes normalized pending approvals as JSON", async () => {
    const now = Date.now();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "exec.approval.list") {
        return [
          {
            id: "exec-json",
            request: {
              command: "uname -a\u001B]52;c;hidden-action\u0007",
              agentId: "main",
              sessionKey: "agent:main:main",
            },
            createdAtMs: now - 2_000,
            expiresAtMs: now + 60_000,
          },
        ];
      }
      return [];
    });

    await runApprovalsCommand(["approvals", "pending", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    expect(writtenJson()).toEqual({
      approvals: [
        {
          id: "exec-json",
          kind: "exec",
          agentId: "main",
          sessionKey: "agent:main:main",
          createdAtMs: now - 2_000,
          expiresAtMs: now + 60_000,
          summary: "uname -a\u001B]52;c;hidden-action\u0007",
        },
      ],
    });
  });

  it("preserves whitespace-bearing ids verbatim and keeps them distinct", async () => {
    const now = Date.now();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "exec.approval.list") {
        return [
          {
            id: " victim ",
            request: { command: "echo padded" },
            createdAtMs: now - 2_000,
            expiresAtMs: now + 60_000,
          },
          {
            id: "victim",
            request: { command: "echo exact" },
            createdAtMs: now - 1_000,
            expiresAtMs: now + 60_000,
          },
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
    // Display forms stay distinct: raw for the safe id, exact id64 token for
    // the padded one.
    expect(approvalDisplayId("victim")).toBe("victim");
    expect(approvalDisplayId(" victim ")).toBe(
      `id64_${Buffer.from(" victim ").toString("base64url")}`,
    );
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

    await runApprovalsCommand(["approvals", "resolve", displayId, "allow-once"]);

    expect(callGatewayFromCli.mock.calls[2]?.[0]).toBe("approval.resolve");
    expect(callGatewayFromCli.mock.calls[2]?.[2]).toEqual({
      id: approvalId,
      kind: "exec",
      decision: "allow-once",
    });
    for (const call of callGatewayFromCli.mock.calls) {
      expect(call[3]).toEqual({
        deviceIdentity: { deviceId: "cli-device" },
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
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "approval.get") {
        return pendingApprovalSnapshot({ id: approvalId });
      }
      return {
        applied: false,
        approval: terminalApprovalSnapshot({
          id: approvalId,
          decision: "deny",
          resolverId: "other-device",
        }),
      };
    });

    await runApprovalsCommand(["approvals", "resolve", approvalId, "deny"]);

    expect(callGatewayFromCli.mock.calls[0]?.[2]).toEqual({ id: approvalId });
    expect(callGatewayFromCli.mock.calls[1]?.[2]).toMatchObject({ id: approvalId });
    expect(runtimeOutput()).toContain("already resolved (same decision: deny)");
    expect(runtimeOutput()).toContain("device:other-device");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("continues with shared credentials when device identity storage is unavailable", async () => {
    loadOrCreateDeviceIdentity.mockImplementationOnce(() => {
      throw new Error("read-only state directory");
    });
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "approval.get") {
        return pendingApprovalSnapshot({ id: "approval-no-device" });
      }
      return {
        applied: true,
        approval: terminalApprovalSnapshot({
          id: "approval-no-device",
          decision: "deny",
        }),
      };
    });

    await runApprovalsCommand([
      "approvals",
      "resolve",
      "approval-no-device",
      "deny",
      "--url",
      "ws://127.0.0.1:18789",
      "--token",
      "test-token",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledTimes(2);
    for (const call of callGatewayFromCli.mock.calls) {
      expect(call[3]).toEqual({ scopes: ["operator.admin", "operator.approvals"] });
    }
  });

  it("rejects an id token that also exists as a raw approval id", async () => {
    // Explicit token form: the display helper renders safe ids raw, but the
    // resolve path must stay ambiguity-safe for pasted tokens regardless.
    const displayId = `id64_${Buffer.from("foo").toString("base64url")}`;
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method !== "approval.get") {
          throw new Error("resolve must not be called");
        }
        const id = String(requireRecord(params, "approval lookup params").id);
        return pendingApprovalSnapshot({ id });
      },
    );

    await expect(runApprovalsCommand(["approvals", "resolve", displayId, "deny"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors[0]).toContain("matches both a raw id and a displayed id token");
    expect(callGatewayFromCli).toHaveBeenCalledTimes(2);
  });

  it("exits non-zero when an approval already has a different decision", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "approval.get") {
        return pendingApprovalSnapshot({ id: "approval-3" });
      }
      return {
        applied: false,
        approval: terminalApprovalSnapshot({ id: "approval-3", decision: "deny" }),
      };
    });

    await expect(
      runApprovalsCommand(["approvals", "resolve", "approval-3", "allow-once"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors[0]).toContain("already resolved with deny by device:device-1");
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("exits non-zero when an approval is not found", async () => {
    callGatewayFromCli.mockRejectedValue(new Error("approval not found"));

    await expect(runApprovalsCommand(["approvals", "resolve", "missing", "deny"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors[0]).toBe("approval not found");
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

    await expect(
      runApprovalsCommand(["approvals", "resolve", "expired-1", "deny"]),
    ).rejects.toThrow("__exit__:1");

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
      runApprovalsCommand(["approvals", "resolve", "system-agent:2", "allow-always"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors[0]).toContain(
      "allow-always is not allowed for system-agent approvals; allowed decisions: allow-once, deny",
    );
    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
  });

  it("adds effective policy to json output", async () => {
    localSnapshot.file = {
      version: 1,
      defaults: { security: "allowlist", ask: "always", askFallback: "deny" },
      agents: {},
    };
    readBestEffortConfig.mockResolvedValue({
      tools: {
        exec: {
          security: "full",
          ask: "off",
        },
      },
    });

    await runApprovalsCommand(["approvals", "get", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    const policy = effectivePolicy();
    expect(String(policy.note)).toContain(
      "Effective exec policy is the host approvals file intersected with requested tools.exec policy.",
    );
    expect(String(policy.note)).toContain(SESSION_EXEC_OVERRIDES_NOTE);
    const scope = scopeByLabel("tools.exec");
    expectFields(requireRecord(scope.security, "tools.exec security"), "tools.exec security", {
      requested: "full",
      host: "allowlist",
      effective: "allowlist",
    });
    expectFields(requireRecord(scope.ask, "tools.exec ask"), "tools.exec ask", {
      requested: "off",
      host: "always",
      effective: "always",
    });
  });

  it("reports wildcard host policy sources in effective policy output", async () => {
    localSnapshot.file = {
      version: 1,
      defaults: { security: "full", ask: "off", askFallback: "full" },
      agents: {
        "*": {
          security: "allowlist",
          ask: "always",
          askFallback: "deny",
        },
      },
    };
    readBestEffortConfig.mockResolvedValue({
      agents: {
        list: [
          {
            id: "runner",
            tools: {
              exec: {
                security: "full",
                ask: "off",
              },
            },
          },
        ],
      },
    });

    await runApprovalsCommand(["approvals", "get", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    const scope = scopeByLabel("agent:runner");
    expect(requireRecord(scope.security, "agent security").hostSource).toBe(
      "/tmp/local-exec-approvals.json agents.*.security",
    );
    expect(requireRecord(scope.ask, "agent ask").hostSource).toBe(
      "/tmp/local-exec-approvals.json agents.*.ask",
    );
    expect(requireRecord(scope.askFallback, "agent askFallback").source).toBe(
      "/tmp/local-exec-approvals.json agents.*.askFallback",
    );
  });

  it("adds combined node effective policy to json output", async () => {
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "config.get") {
          return {
            config: {
              tools: {
                exec: {
                  security: "full",
                  ask: "off",
                },
              },
            },
          };
        }
        if (method === "exec.approvals.node.get") {
          return {
            path: "/tmp/node-exec-approvals.json",
            exists: true,
            hash: "hash-node-1",
            file: {
              version: 1,
              defaults: { security: "allowlist", ask: "always", askFallback: "deny" },
              agents: {},
            },
            resolvedDefaults: {
              security: "allowlist",
              ask: "always",
              askFallback: "deny",
              autoAllowSkills: false,
            },
          };
        }
        return { method, params };
      },
    );

    await runApprovalsCommand(["approvals", "get", "--node", "macbook", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    const policy = effectivePolicy();
    expect(String(policy.note)).toContain(
      "Effective exec policy is the node host approvals file intersected with gateway tools.exec policy.",
    );
    expect(String(policy.note)).toContain(SESSION_EXEC_OVERRIDES_NOTE);
    const scope = scopeByLabel("tools.exec");
    expectFields(requireRecord(scope.security, "tools.exec security"), "tools.exec security", {
      requested: "full",
      host: "allowlist",
      effective: "allowlist",
    });
    expectFields(requireRecord(scope.ask, "tools.exec ask"), "tools.exec ask", {
      requested: "off",
      host: "always",
      effective: "always",
    });
    expectFields(
      requireRecord(scope.askFallback, "tools.exec askFallback"),
      "tools.exec askFallback",
      {
        effective: "deny",
        source: "/tmp/node-exec-approvals.json defaults.askFallback",
      },
    );
  });

  it("uses node-reported defaults for omitted host policy", async () => {
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "config.get") {
          return { config: { tools: { exec: { security: "full", ask: "off" } } } };
        }
        if (method === "exec.approvals.node.get") {
          return {
            path: "/tmp/node-exec-approvals.json",
            exists: true,
            hash: "hash-node-1",
            file: { version: 1, agents: {} },
            resolvedDefaults: {
              security: "deny",
              ask: "on-miss",
              askFallback: "deny",
              autoAllowSkills: false,
            },
          };
        }
        return { method, params };
      },
    );

    await runApprovalsCommand(["approvals", "get", "--node", "macbook", "--json"]);

    const scope = scopeByLabel("tools.exec");
    expectFields(requireRecord(scope.security, "tools.exec security"), "tools.exec security", {
      requested: "full",
      host: "deny",
      hostSource: "node-reported resolved defaults",
      effective: "deny",
    });
    expectFields(requireRecord(scope.ask, "tools.exec ask"), "tools.exec ask", {
      requested: "off",
      host: "on-miss",
      hostSource: "node-reported resolved defaults",
      effective: "on-miss",
    });
  });

  it("does not infer permissive policy for legacy node snapshots", async () => {
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "config.get") {
          return { config: { tools: { exec: { security: "full", ask: "off" } } } };
        }
        if (method === "exec.approvals.node.get") {
          return {
            path: "/tmp/node-exec-approvals.json",
            exists: true,
            hash: "hash-node-1",
            file: {
              version: 1,
              defaults: {
                security: "full",
                ask: "off",
                askFallback: "full",
                autoAllowSkills: true,
              },
              agents: {},
            },
          };
        }
        return { method, params };
      },
    );

    await runApprovalsCommand(["approvals", "get", "--node", "macbook", "--json"]);

    expect(effectivePolicy()).toEqual({
      scopes: [],
      note: "This node does not expose a complete resolved host policy, so Effective Policy is unavailable.",
    });
  });

  it("shows host-native node approvals without approvals-file policy math", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return { config: { tools: { exec: { security: "full", ask: "off" } } } };
      }
      if (method === "exec.approvals.node.get") {
        return {
          enabled: true,
          hash: "sha256:current",
          baseHash: "sha256:current",
          defaultAction: "deny",
          rules: [{ pattern: "hostname", action: "allow" }],
        } as never;
      }
      return {} as never;
    });

    await runApprovalsCommand(["approvals", "get", "--node", "windows", "--json"]);

    expect(writtenJson().defaultAction).toBe("deny");
    expect(effectivePolicy()).toEqual({
      note: "This node enforces a host-native exec policy; OpenClaw approvals-file policy math does not apply.",
      scopes: [],
    });
    expect(callGatewayFromCli.mock.calls.map((call) => call[0])).toEqual([
      "exec.approvals.node.get",
    ]);
    expect(runtimeErrors).toHaveLength(0);
  });

  it("writes host-native node approvals with the current hash", async () => {
    const dir = tempDirs.make("openclaw-native-approvals-");
    const policyPath = path.join(dir, "policy.json");
    fs.writeFileSync(
      policyPath,
      JSON.stringify({
        defaultAction: "deny",
        rules: [{ pattern: "hostname", action: "allow" }],
      }),
    );
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "exec.approvals.node.get") {
          return {
            enabled: true,
            hash: "sha256:current",
            defaultAction: "deny",
            rules: [],
          } as never;
        }
        return { method, params };
      },
    );

    await runApprovalsCommand([
      "approvals",
      "set",
      "--node",
      "windows",
      "--file",
      policyPath,
      "--json",
    ]);

    expect(callGatewayFromCli.mock.calls[1]?.[0]).toBe("exec.approvals.node.set");
    expect(callGatewayFromCli.mock.calls[1]?.[2]).toEqual({
      nodeId: "node-1",
      native: {
        defaultAction: "deny",
        rules: [{ pattern: "hostname", action: "allow" }],
      },
      baseHash: "sha256:current",
    });
    expect(callGatewayFromCli.mock.calls[2]?.[0]).toBe("exec.approvals.node.get");
    expect(runtimeErrors).toHaveLength(0);
  });

  it("rejects unknown host-native policy fields instead of dropping them", async () => {
    const dir = tempDirs.make("openclaw-native-approvals-");
    const policyPath = path.join(dir, "policy.json");
    fs.writeFileSync(
      policyPath,
      JSON.stringify({ rules: [{ pattern: "hostname", action: "allow", shell: "powershell" }] }),
    );
    callGatewayFromCli.mockResolvedValue({
      enabled: true,
      hash: "sha256:current",
      defaultAction: "deny",
      rules: [],
    } as never);

    await expect(
      runApprovalsCommand(["approvals", "set", "--node", "windows", "--file", policyPath]),
    ).rejects.toThrow("__exit__:1");

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    expect(runtimeErrors[0]).toContain("Unknown host-native exec approval rule 1 field: shell");
  });

  it("rejects remote configuration when a host-native policy is disabled", async () => {
    callGatewayFromCli.mockResolvedValue({
      enabled: false,
      message: "No exec policy configured",
    } as never);

    await expect(
      runApprovalsCommand([
        "approvals",
        "set",
        "--node",
        "windows",
        "--file",
        "/does/not/exist.json",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    expect(runtimeErrors[0]).toContain("disabled on this node and cannot be configured remotely");
  });

  it("rejects allowlist helpers for host-native nodes", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "exec.approvals.node.get") {
        return {
          enabled: true,
          hash: "sha256:current",
          defaultAction: "deny",
          rules: [],
        } as never;
      }
      return {} as never;
    });

    await expect(
      runApprovalsCommand(["approvals", "allowlist", "add", "--node", "windows", "hostname"]),
    ).rejects.toThrow("__exit__:1");

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    expect(runtimeErrors[0]).toContain("do not support allowlist mutations");
  });

  it("keeps gateway approvals output when config.get fails", async () => {
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "config.get") {
          throw new Error("gateway config unavailable");
        }
        if (method === "exec.approvals.get") {
          return {
            path: "/tmp/exec-approvals.json",
            exists: true,
            hash: "hash-1",
            file: { version: 1, agents: {} },
          };
        }
        return { method, params };
      },
    );

    await runApprovalsCommand(["approvals", "get", "--gateway", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    expect(effectivePolicy()).toEqual({
      note: "Config unavailable.",
      scopes: [],
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("reports gateway config timeout explicitly", async () => {
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "config.get") {
          throw new Error("gateway timeout after 10000ms\u001b[2K\u0007\nRPC config.get");
        }
        if (method === "exec.approvals.get") {
          return {
            path: "/tmp/exec-approvals.json",
            exists: true,
            hash: "hash-1",
            file: { version: 1, agents: {} },
          };
        }
        return { method, params };
      },
    );

    await runApprovalsCommand(["approvals", "get", "--gateway", "--timeout", "10000", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    expect(effectivePolicy()).toEqual({
      note: "Config fetch timed out. Re-run with a higher --timeout to inspect Effective Policy.",
      scopes: [],
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("keeps node approvals output when gateway config is unavailable", async () => {
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "config.get") {
          throw new Error("gateway config unavailable");
        }
        if (method === "exec.approvals.node.get") {
          return {
            path: "/tmp/node-exec-approvals.json",
            exists: true,
            hash: "hash-node-1",
            file: { version: 1, agents: {} },
          };
        }
        return { method, params };
      },
    );

    await runApprovalsCommand(["approvals", "get", "--node", "macbook", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    expect(effectivePolicy()).toEqual({
      note: "Gateway config unavailable. Node output above shows host approvals state only, and final runtime policy still intersects with gateway tools.exec.",
      scopes: [],
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("keeps local approvals output when config load fails", async () => {
    readBestEffortConfig.mockRejectedValue(new Error("duplicate agent directories"));

    await runApprovalsCommand(["approvals", "get", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    expect(effectivePolicy()).toEqual({
      note: "Config unavailable.",
      scopes: [],
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("reports agent scopes with inherited global requested policy", async () => {
    localSnapshot.file = {
      version: 1,
      agents: {
        runner: {
          security: "allowlist",
          ask: "always",
        },
      },
    };
    readBestEffortConfig.mockResolvedValue({
      tools: {
        exec: {
          security: "full",
          ask: "off",
        },
      },
      agents: {
        list: [{ id: "runner" }],
      },
    });

    await runApprovalsCommand(["approvals", "get", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);

    const toolsScope = scopeByLabel("tools.exec");
    expectFields(requireRecord(toolsScope.security, "tools.exec security"), "tools.exec security", {
      requested: "full",
      requestedSource: "tools.exec.security",
      effective: "full",
    });
    expectFields(requireRecord(toolsScope.ask, "tools.exec ask"), "tools.exec ask", {
      requested: "off",
      requestedSource: "tools.exec.ask",
      effective: "off",
    });
    expectFields(
      requireRecord(toolsScope.askFallback, "tools.exec askFallback"),
      "tools.exec askFallback",
      {
        effective: "deny",
        source: "OpenClaw default (deny)",
      },
    );

    const agentScope = scopeByLabel("agent:runner");
    expectFields(requireRecord(agentScope.security, "agent security"), "agent security", {
      requested: "full",
      requestedSource: "tools.exec.security",
      effective: "allowlist",
    });
    expectFields(requireRecord(agentScope.ask, "agent ask"), "agent ask", {
      requested: "off",
      requestedSource: "tools.exec.ask",
      effective: "always",
    });
    expectFields(requireRecord(agentScope.askFallback, "agent askFallback"), "agent askFallback", {
      effective: "deny",
      source: "OpenClaw default (deny)",
    });
  });

  it("defaults allowlist add to wildcard agent", async () => {
    const updateExecApprovals = vi.mocked(execApprovals.updateExecApprovals);
    updateExecApprovals.mockClear();

    await runApprovalsCommand(["approvals", "allowlist", "add", "/usr/bin/uname"]);

    expect(callGatewayFromCli.mock.calls.some((call) => call[0] === "exec.approvals.set")).toBe(
      false,
    );
    const saved = requireRecord(localSnapshot.file, "saved approvals");
    expect(updateExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({ baseHash: "hash-local" }),
    );
    if (requireRecord(saved.agents, "saved agents")["*"] === undefined) {
      throw new Error("Expected wildcard exec approval agent entry");
    }
  });

  it("removes wildcard allowlist entry and prunes empty agent", async () => {
    localSnapshot.file = {
      version: 1,
      agents: {
        "*": {
          allowlist: [{ pattern: "/usr/bin/uname", lastUsedAt: Date.now() }],
        },
      },
    };

    const updateExecApprovals = vi.mocked(execApprovals.updateExecApprovals);
    updateExecApprovals.mockClear();

    await runApprovalsCommand(["approvals", "allowlist", "remove", "/usr/bin/uname"]);

    const saved = requireRecord(localSnapshot.file, "saved approvals");
    expect(updateExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({ baseHash: "hash-local" }),
    );
    expectFields(saved, "saved approvals", {
      version: 1,
      agents: {},
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("bounds approvals JSON read from stdin", async () => {
    await expect(testing.readStdin(Readable.from(["12345"]), 5)).resolves.toBe("12345");
    await expect(testing.readStdin(Readable.from(["12345", "6"]), 5)).rejects.toThrow(
      "Exec approvals stdin exceeds 5 bytes.",
    );
  });

  it("reads approvals JSON from a regular file", async () => {
    const dir = tempDirs.make("openclaw-approvals-file-bound-");
    const filePath = path.join(dir, "approvals.json");
    fs.writeFileSync(filePath, JSON.stringify({ defaultAction: "deny", rules: [] }));

    await runNativeApprovalsFileCommand(filePath);

    expect(callGatewayFromCli.mock.calls.map(([method]) => method)).toEqual([
      "exec.approvals.node.get",
      "exec.approvals.node.set",
      "exec.approvals.node.get",
    ]);
    expect(runtimeErrors).toHaveLength(0);
  });

  it("rejects an oversized approvals file", async () => {
    const dir = tempDirs.make("openclaw-approvals-file-bound-");
    const filePath = path.join(dir, "oversized.json");
    fs.writeFileSync(filePath, Buffer.alloc(1024 * 1024 + 1, "x"));

    await expect(runNativeApprovalsFileCommand(filePath)).rejects.toThrow("__exit__:1");

    expect(runtimeErrors[0]).toContain("File exceeds 1048576 bytes");
    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
  });

  it("preserves the directory read error", async () => {
    const dir = tempDirs.make("openclaw-approvals-file-directory-");

    await expect(runNativeApprovalsFileCommand(dir)).rejects.toThrow("__exit__:1");

    expect(runtimeErrors[0]).toMatch(/EISDIR|directory/i);
    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
  });

  it("follows a symlinked approvals file", async () => {
    const dir = tempDirs.make("openclaw-approvals-file-symlink-");
    const targetPath = path.join(dir, "target.json");
    const symlinkPath = path.join(dir, "approvals.json");
    fs.writeFileSync(targetPath, JSON.stringify({ defaultAction: "deny", rules: [] }));
    fs.symlinkSync(targetPath, symlinkPath);

    await runNativeApprovalsFileCommand(symlinkPath);

    expect(callGatewayFromCli.mock.calls.map(([method]) => method)).toContain(
      "exec.approvals.node.set",
    );
    expect(runtimeErrors).toHaveLength(0);
  });

  it("rejects a file that grows past the limit after opening", async () => {
    const dir = tempDirs.make("openclaw-approvals-file-growth-");
    const filePath = path.join(dir, "growing.json");
    fs.writeFileSync(filePath, Buffer.alloc(1024 * 1024, "x"));
    const open = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      fs.appendFileSync(filePath, "x");
      return handle;
    });

    try {
      await expect(runNativeApprovalsFileCommand(filePath)).rejects.toThrow("__exit__:1");
    } finally {
      openSpy.mockRestore();
    }

    expect(runtimeErrors[0]).toContain("File exceeds 1048576 bytes");
    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
  });
});
