import "./exec-approvals-cli.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SESSION_EXEC_OVERRIDES_NOTE } from "../infra/exec-approvals-effective.js";
import * as execApprovals from "../infra/exec-approvals.js";
import { testing } from "./exec-approvals-cli.js";

const {
  callGatewayFromCli,
  defaultRuntime,
  localSnapshot,
  loggedOutput,
  readBestEffortConfig,
  resetExecApprovalsCliMocks,
  runApprovalsCommand,
  runtimeErrors,
} = await import("./exec-approvals-cli.test-support.js");

describe("exec approvals CLI error formatting", () => {
  it("keeps the bounded first line UTF-16 well-formed", () => {
    const message = testing.formatCliError(`${"x".repeat(299)}🚀tail\nignored`);

    expect(message).toBe(`${"x".repeat(299)}...`);
  });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createMcpToolGrant(tool = "publish_page") {
  return { server: "project-docs", tool, source: "allow-always" as const, addedAt: Date.now() };
}

const requireRecord = createRequireRecord("record", "expected-label-capitalized");

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

function effectivePolicy(output: Record<string, unknown> = writtenJson()) {
  return requireRecord(output.effectivePolicy, "effective policy");
}

describe("exec approvals CLI", () => {
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

  beforeEach(resetExecApprovalsCliMocks);

  it.each([
    ["gateway", ["--gateway"], "exec.approvals.get"],
    ["node", ["--node", "macbook"], "exec.approvals.node.get"],
  ] as const)("routes get command to %s mode", async (target, args, method) => {
    await runApprovalsCommand(["approvals", "get", ...args]);

    expectGatewayCall(0, method, target === "node" ? { nodeId: "node-1" } : {});
    expectGatewayCall(1, "config.get", {});
    expect(
      defaultRuntime.log.mock.calls.filter(([line]) =>
        String(line ?? "").includes(SESSION_EXEC_OVERRIDES_NOTE),
      ),
    ).toHaveLength(1);
    expect(runtimeErrors).toHaveLength(0);
  });

  it("renders an unstored fresh-install policy as defaults instead of absent", async () => {
    localSnapshot.exists = false;

    await runApprovalsCommand(["approvals", "get"]);

    const output = loggedOutput();
    expect(output).toContain("State");
    expect(output).toContain("defaults (no stored overrides)");
    expect(output).not.toContain("Exists");
  });

  it("sanitizes stored allowlist patterns in human output without changing JSON", async () => {
    const pattern = "/tmp/safe\u001b[31mred\u001b[0m\u001b]0;pwned\u0007\nnext\trow\rback\bspace🦞";
    localSnapshot.file = {
      version: 1,
      agents: { "*": { allowlist: [{ pattern }] } },
    };

    await runApprovalsCommand(["approvals", "get"]);

    const output = loggedOutput();
    const hasUnsafeControl = Array.from(output).some((char) => {
      const codePoint = char.codePointAt(0) ?? -1;
      return (
        codePoint === 0x07 ||
        codePoint === 0x08 ||
        codePoint === 0x1b ||
        (codePoint >= 0x7f && codePoint <= 0x9f)
      );
    });
    expect(hasUnsafeControl).toBe(false);
    expect(output).toContain("safered\\nnext\\trow\\rbackspace🦞");

    defaultRuntime.writeJson.mockClear();
    await runApprovalsCommand(["approvals", "get", "--json"]);

    const file = requireRecord(writtenJson().file, "JSON approvals file");
    const agents = requireRecord(file.agents, "JSON approvals agents");
    const wildcard = requireRecord(agents["*"], "JSON wildcard agent");
    const allowlist = requireArray(wildcard.allowlist, "JSON wildcard allowlist");
    expect(requireRecord(allowlist[0], "JSON allowlist entry").pattern).toBe(pattern);
  });

  it("keeps grant scopes distinct in a 40-column terminal", async () => {
    const columns = 40;
    const originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
    try {
      const pattern = "/usr/bin/git";
      const lastUsedAt = 1;
      localSnapshot.file = {
        version: 1,
        agents: {
          main: {
            allowlist: [
              { pattern, lastUsedAt },
              { pattern, argPattern: "^status$", lastUsedAt },
              {
                pattern,
                source: "allow-always",
                argPattern: execApprovals.buildCwdBoundHashedArgPattern(
                  [pattern, "status"],
                  "/workspace",
                ),
                lastUsedAt,
              },
              { pattern, source: "allow-always", lastUsedAt },
              { pattern: "=command:manual0000000000", lastUsedAt },
              { pattern: "=command:generated00000", source: "allow-always", lastUsedAt },
              { pattern, argPattern: "sha256:argv:obsolete", lastUsedAt },
            ],
          },
        },
      };
      await runApprovalsCommand(["approvals", "get"]);
      const rows = loggedOutput()
        .split("\n")
        .filter((line) => line.startsWith("│ local"));
      expect(rows).toHaveLength(7);
      expect(new Set(rows.slice(0, 4)).size).toBe(4);
      for (const [index, scope] of [
        "any args",
        "argv",
        "argv+cwd",
        "inactive",
        "any args",
        "command text",
        "inactive",
      ].entries()) {
        expect(rows[index]).toContain(scope);
      }
      expect(rows[6]).not.toMatch(/\bargv\b/);
    } finally {
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: originalColumns,
      });
    }
  });

  it("redacts the socket token from local get JSON while preserving its path", async () => {
    localSnapshot.file = {
      version: 1,
      socket: { path: "/tmp/local-exec-approvals.sock", token: "fixture-token" },
      agents: {},
    };

    await runApprovalsCommand(["approvals", "get", "--json"]);

    const output = writtenJson();
    const file = requireRecord(output.file, "JSON approvals file");
    expect(file.socket).toEqual({ path: "/tmp/local-exec-approvals.sock" });
    expect(JSON.stringify(output)).not.toContain('"token"');
  });

  it("redacts the socket token from local write JSON while preserving its path", async () => {
    localSnapshot.file = {
      version: 1,
      socket: { path: "/tmp/local-exec-approvals.sock", token: "fixture-token" },
      agents: {},
    };

    await runApprovalsCommand(["approvals", "allowlist", "add", "/usr/bin/uname", "--json"]);

    const output = writtenJson();
    const file = requireRecord(output.file, "JSON approvals file");
    expect(file.socket).toEqual({ path: "/tmp/local-exec-approvals.sock" });
    expect(output.raw).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain('"token"');
    expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    expect(loggedOutput()).not.toContain("Writing approvals for this state root.");
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

  it.each([
    {
      label: "keeps gateway approvals output when config.get fails",
      args: ["--gateway"],
      method: "exec.approvals.get",
      error: "gateway config unavailable",
      note: "Config unavailable.",
    },
    {
      label: "reports gateway config timeout explicitly",
      args: ["--gateway", "--timeout", "10000"],
      method: "exec.approvals.get",
      error: "gateway timeout after 10000ms\u001b[2K\u0007\nRPC config.get",
      note: "Config fetch timed out. Re-run with a higher --timeout to inspect Effective Policy.",
    },
    {
      label: "keeps node approvals output when gateway config is unavailable",
      args: ["--node", "macbook"],
      method: "exec.approvals.node.get",
      error: "gateway config unavailable",
      note: "Gateway config unavailable. Node output above shows host approvals state only, and final runtime policy still intersects with gateway tools.exec.",
    },
  ])("$label", async ({ args, method: snapshotMethod, error, note }) => {
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "config.get") {
          throw new Error(error);
        }
        if (method === snapshotMethod) {
          return localSnapshot;
        }
        return { method, params };
      },
    );

    await runApprovalsCommand(["approvals", "get", ...args, "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    expect(effectivePolicy()).toEqual({ note, scopes: [] });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("adds an allowlist entry for a configured agent", async () => {
    readBestEffortConfig.mockResolvedValue({ agents: { entries: { main: {} } } });
    const updateExecApprovals = vi.mocked(execApprovals.updateExecApprovals);
    updateExecApprovals.mockClear();

    await runApprovalsCommand([
      "approvals",
      "allowlist",
      "add",
      "/usr/bin/uname",
      "--agent",
      "main",
    ]);

    expect(callGatewayFromCli.mock.calls.some((call) => call[0] === "exec.approvals.set")).toBe(
      false,
    );
    const saved = requireRecord(localSnapshot.file, "saved approvals");
    expect(updateExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({ baseHash: "hash-local" }),
    );
    if (requireRecord(saved.agents, "saved agents").main === undefined) {
      throw new Error("Expected main exec approval agent entry");
    }
    expect(readBestEffortConfig).toHaveBeenCalledTimes(1);
    expect(loggedOutput()).toContain("Writing approvals for this state root.");
  });

  it("rejects an unknown agent before allowlist add persistence", async () => {
    readBestEffortConfig.mockResolvedValue({ agents: { entries: { main: {} } } });
    const updateExecApprovals = vi.mocked(execApprovals.updateExecApprovals);
    updateExecApprovals.mockClear();

    await expect(
      runApprovalsCommand([
        "approvals",
        "allowlist",
        "add",
        "/usr/bin/uname",
        "--agent",
        "nope-agent",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toStrictEqual([
      'Unknown agent id "nope-agent". Run openclaw agents list to see configured agents.',
    ]);
    expect(updateExecApprovals).not.toHaveBeenCalled();
    expect(localSnapshot.file.agents).toEqual({});
    expect(loggedOutput()).not.toContain("Writing approvals for this state root.");
  });

  it("rejects a blank agent before allowlist remove persistence", async () => {
    const updateExecApprovals = vi.mocked(execApprovals.updateExecApprovals);
    updateExecApprovals.mockClear();

    await expect(
      runApprovalsCommand(["approvals", "allowlist", "remove", "/usr/bin/uname", "--agent", ""]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toStrictEqual(["--agent must not be blank"]);
    expect(updateExecApprovals).not.toHaveBeenCalled();
    expect(localSnapshot.file.agents).toEqual({});
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
    expect(loggedOutput()).toContain("Writing approvals for this state root.");
    expect(runtimeErrors).toHaveLength(0);
  });

  it("keeps MCP tool grants when removing the last exec allowlist entry", async () => {
    readBestEffortConfig.mockResolvedValue({ agents: { entries: { main: {} } } });
    const grant = createMcpToolGrant();
    localSnapshot.file = {
      version: 1,
      agents: { main: { allowlist: [{ pattern: "/usr/bin/uname" }], mcpTools: [grant] } },
    };

    await runApprovalsCommand([
      "approvals",
      "allowlist",
      "remove",
      "/usr/bin/uname",
      "--agent",
      "main",
    ]);

    expect(localSnapshot.file.agents).toEqual({ main: { mcpTools: [grant] } });
  });

  it("revokes one MCP tool grant through approvals set while preserving the others", async () => {
    const retainedGrant = createMcpToolGrant("read_page");
    localSnapshot.file = {
      version: 1,
      agents: {
        main: { mcpTools: [retainedGrant, { ...retainedGrant, tool: "publish_page" }] },
      },
    };
    const filePath = path.join(tempDirs.make("openclaw-mcp-grants-revoke-"), "approvals.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        agents: { main: { mcpTools: [retainedGrant] } },
      }),
    );

    await runApprovalsCommand(["approvals", "set", "--file", filePath, "--json"]);

    expect(localSnapshot.file.agents).toEqual({ main: { mcpTools: [retainedGrant] } });
    expect(requireRecord(writtenJson().file, "JSON approvals file").agents).toEqual(
      localSnapshot.file.agents,
    );
  });

  it("bounds approvals JSON read from stdin", async () => {
    await expect(testing.readStdin(Readable.from(["12345"]), 5)).resolves.toBe("12345");
    await expect(testing.readStdin(Readable.from(["12345", "6"]), 5)).rejects.toThrow(
      "Exec approvals stdin exceeds 5 bytes.",
    );
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
      await expect(runNativeApprovalsFileCommand(filePath)).rejects.toThrow(
        "File exceeds 1048576 bytes",
      );
    } finally {
      openSpy.mockRestore();
    }

    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(runtimeErrors).toHaveLength(0);
    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
  });
});

describe("exec approvals allowlist JSON no-ops", () => {
  beforeEach(resetExecApprovalsCliMocks);

  it.each([
    ["local", [], null],
    ["gateway", ["--gateway"], "exec.approvals.get"],
  ] as const)(
    "reports JSON no-ops without saving on the %s target",
    async (_target, args, method) => {
      for (const operation of ["add", "remove"] as const) {
        const socketPath = "/tmp/noop-exec-approvals.sock";
        localSnapshot.file = {
          version: 1,
          socket: { path: socketPath, token: "fixture-noop-token" },
          ...(operation === "add"
            ? { agents: { "*": { allowlist: [{ pattern: "/usr/bin/uptime", lastUsedAt: 123 }] } } }
            : {}),
        };
        const snapshot = {
          path: localSnapshot.path,
          exists: localSnapshot.exists,
          hash: localSnapshot.hash,
          file: localSnapshot.file,
        };
        const before = structuredClone(snapshot);
        const updateExecApprovals = vi.mocked(execApprovals.updateExecApprovals);
        updateExecApprovals.mockClear();
        callGatewayFromCli.mockClear();
        defaultRuntime.log.mockClear();
        defaultRuntime.writeJson.mockClear();
        if (method) {
          callGatewayFromCli.mockResolvedValueOnce(snapshot);
        }

        await runApprovalsCommand([
          "approvals",
          "allowlist",
          operation,
          "/usr/bin/uptime",
          ...args,
          "--json",
        ]);

        expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(
          { ...before, file: { ...before.file, socket: { path: socketPath } } },
          0,
        );
        const output = defaultRuntime.writeJson.mock.calls[0]?.[0];
        expect(output).not.toHaveProperty("raw");
        expect(JSON.stringify(output)).not.toContain("fixture-noop-token");
        expect(snapshot).toEqual(before);
        expect(updateExecApprovals).not.toHaveBeenCalled();
        expect(callGatewayFromCli.mock.calls.map(([called]) => called)).toEqual(
          method ? [method] : [],
        );
        expect(loggedOutput()).not.toContain("Writing approvals for this state root.");
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
        expect(runtimeErrors).toHaveLength(0);
      }
    },
  );
});
