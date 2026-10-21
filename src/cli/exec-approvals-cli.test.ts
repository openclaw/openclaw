import "./exec-approvals-cli.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SESSION_EXEC_OVERRIDES_NOTE } from "../infra/exec-approvals-effective.js";
import * as execApprovals from "../infra/exec-approvals.js";

const {
  callGatewayFromCli,
  defaultRuntime,
  localSnapshot,
  loggedOutput,
  readBestEffortConfig,
  resetExecApprovalsCliMocks,
  runApprovalsCommand,
  runtimeErrors,
  runtimeLogs,
  setLocalSocket,
} = await import("./exec-approvals-cli.test-support.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createMcpToolGrant(tool = "publish_page") {
  return { server: "project-docs", tool, source: "allow-always" as const, addedAt: Date.now() };
}

const requireRecord = createRequireRecord("record", "expected-label-capitalized");

function expectGatewayCall(index: number, method: string, params: unknown) {
  expect(callGatewayFromCli.mock.calls[index]?.slice(0, 3)).toEqual([
    method,
    expect.objectContaining({ timeout: "60000" }),
    params,
  ]);
}

function writtenJson(): Record<string, unknown> {
  return requireRecord(defaultRuntime.writeJson.mock.calls[0]?.[0], "written json");
}

function effectivePolicy(output: Record<string, unknown> = writtenJson()) {
  return requireRecord(output.effectivePolicy, "effective policy");
}

const nativePolicy = { defaultAction: "deny", rules: [{ pattern: "hostname", action: "allow" }] };
const nativeSnapshot = { enabled: true, hash: "sha256:current", defaultAction: "deny", rules: [] };
const nativeFileArgs = (filePath: string) => [
  "approvals",
  "set",
  "--node",
  "windows",
  "--file",
  filePath,
];
function policyFile(contents: unknown) {
  const filePath = path.join(tempDirs.make("openclaw-approvals-"), "policy.json");
  fs.writeFileSync(filePath, JSON.stringify(contents));
  return filePath;
}

describe("exec approvals CLI", () => {
  const runNativeApprovalsFileCommand = async (filePath: string) => {
    callGatewayFromCli.mockResolvedValue(nativeSnapshot);
    await runApprovalsCommand([...nativeFileArgs(filePath), "--json"]);
  };

  beforeEach(resetExecApprovalsCliMocks);

  it.each([
    ["gateway", ["--gateway"], "exec.approvals.get"],
    ["node", ["--node", "macbook"], "exec.approvals.node.get"],
  ] as const)("routes get command to %s mode", async (target, args, method) => {
    await runApprovalsCommand(["approvals", "get", ...args]);

    expectGatewayCall(0, method, target === "node" ? { nodeId: "node-1" } : {});
    expectGatewayCall(1, "config.get", {});
    expect(runtimeLogs.filter((line) => line.includes(SESSION_EXEC_OVERRIDES_NOTE))).toHaveLength(
      1,
    );
    expect(runtimeErrors).toHaveLength(0);
  });

  it.each([
    ["get", ["approvals", "get"]],
    ["allowlist add", ["approvals", "allowlist", "add", "/usr/bin/uname"]],
  ] as const)(
    "%s rejects --gateway combined with --node instead of silently routing to the gateway",
    async (_label, baseArgs) => {
      await expect(
        runApprovalsCommand([...baseArgs, "--gateway", "--node", "macbook"]),
      ).rejects.toThrow("__exit__:1");
      expect(runtimeErrors.join("\n")).toContain("Pass only one of --gateway or --node.");
      expect(callGatewayFromCli).not.toHaveBeenCalled();
    },
  );

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
    setLocalSocket("/tmp/local-exec-approvals.sock", "fixture-token");
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
    expect(file.socket).toEqual({ path: "/tmp/local-exec-approvals.sock" });
    expect(JSON.stringify(writtenJson())).not.toContain('"token"');
    expect(file.agents).toMatchObject({ "*": { allowlist: [{ pattern }] } });
  });

  it("redacts the socket token from local write JSON while preserving its path", async () => {
    setLocalSocket("/tmp/local-exec-approvals.sock", "fixture-token");
    localSnapshot.file = {
      version: 1,
      agents: {},
    };

    await runApprovalsCommand(["approvals", "allowlist", "add", "/usr/bin/uname", "--json"]);

    const output = writtenJson();
    const file = requireRecord(output.file, "JSON approvals file");
    expect(file.socket).toEqual({ path: "/tmp/local-exec-approvals.sock" });
    expect(output.raw).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain('"token"');
    expect(localSnapshot.file.socket).toBeUndefined();
    expect(localSnapshot.raw).not.toContain("fixture-token");
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
        return { ...nativeSnapshot, ...nativePolicy, baseHash: "sha256:current" };
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
    const policyPath = policyFile(nativePolicy);
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "exec.approvals.node.get") {
          return nativeSnapshot;
        }
        return { method, params };
      },
    );

    await runApprovalsCommand([...nativeFileArgs(policyPath), "--json"]);

    expect(callGatewayFromCli.mock.calls[1]?.[0]).toBe("exec.approvals.node.set");
    expect(callGatewayFromCli.mock.calls[1]?.[2]).toEqual({
      nodeId: "node-1",
      native: nativePolicy,
      baseHash: "sha256:current",
    });
    expect(callGatewayFromCli.mock.calls[2]?.[0]).toBe("exec.approvals.node.get");
    expect(runtimeErrors).toHaveLength(0);
  });

  it("rejects unknown host-native policy fields instead of dropping them", async () => {
    const policyPath = policyFile({ rules: [{ ...nativePolicy.rules[0], shell: "powershell" }] });
    callGatewayFromCli.mockResolvedValue(nativeSnapshot);

    await expect(runApprovalsCommand(nativeFileArgs(policyPath))).rejects.toThrow("__exit__:1");

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    expect(runtimeErrors[0]).toContain("Unknown host-native exec approval rule 1 field: shell");
  });

  it("rejects remote configuration when a host-native policy is disabled", async () => {
    callGatewayFromCli.mockResolvedValue({
      enabled: false,
      message: "No exec policy configured",
    } as never);

    await expect(runApprovalsCommand(nativeFileArgs("/does/not/exist.json"))).rejects.toThrow(
      "__exit__:1",
    );

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    expect(runtimeErrors[0]).toContain("disabled on this node and cannot be configured remotely");
  });

  it("rejects allowlist helpers for host-native nodes", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "exec.approvals.node.get") {
        return nativeSnapshot;
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
    expect(updateExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({ baseHash: "hash-local" }),
      expect.anything(),
    );
    expect(localSnapshot.file.agents?.main).toBeDefined();
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

    expect(updateExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({ baseHash: "hash-local" }),
      expect.anything(),
    );
    expect([localSnapshot.file.version, localSnapshot.file.agents]).toEqual([1, {}]);
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
    const filePath = policyFile({ version: 1, agents: { main: { mcpTools: [retainedGrant] } } });

    await runApprovalsCommand(["approvals", "set", "--file", filePath, "--json"]);

    expect(localSnapshot.file.agents).toEqual({ main: { mcpTools: [retainedGrant] } });
    expect(requireRecord(writtenJson().file, "JSON approvals file").agents).toEqual(
      localSnapshot.file.agents,
    );
  });

  it.each([0, 1])(
    "enforces the stdin byte cap with %i excess bytes before saving",
    async (excessBytes) => {
      const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
      if (!originalStdin) {
        throw new Error("Expected process.stdin");
      }
      const input = '{defaults:{security:"deny"}}';
      const stream = Readable.from([
        input,
        Buffer.alloc(1024 * 1024 - Buffer.byteLength(input) + excessBytes, " "),
      ]);
      const updateExecApprovals = vi.mocked(execApprovals.updateExecApprovals).mockClear();
      Object.defineProperty(process, "stdin", { configurable: true, value: stream });
      try {
        const command = runApprovalsCommand(["approvals", "set", "--stdin", "--json"]);
        if (excessBytes) {
          await expect(command).rejects.toThrow("Exec approvals stdin exceeds 1048576 bytes.");
          expect(updateExecApprovals).not.toHaveBeenCalled();
          expect(localSnapshot.file).toEqual({ version: 1, agents: {} });
          expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
        } else {
          await command;
          expect(updateExecApprovals).toHaveBeenCalledTimes(1);
          expect(localSnapshot.file.defaults).toEqual({ security: "deny" });
          expect(requireRecord(writtenJson().file, "JSON approvals file").defaults).toEqual({
            security: "deny",
          });
        }
      } finally {
        Object.defineProperty(process, "stdin", originalStdin);
      }
    },
  );

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
        setLocalSocket(socketPath, "fixture-noop-token");
        localSnapshot.file = {
          version: 1,
          ...(operation === "add"
            ? { agents: { "*": { allowlist: [{ pattern: "/usr/bin/uptime", lastUsedAt: 123 }] } } }
            : {}),
        };
        const snapshot = {
          path: localSnapshot.path,
          exists: localSnapshot.exists,
          hash: localSnapshot.hash,
          file: {
            ...localSnapshot.file,
            socket: { path: socketPath, token: "fixture-noop-token" },
          },
        };
        const before = structuredClone(snapshot);
        const updateExecApprovals = vi.mocked(execApprovals.updateExecApprovals);
        updateExecApprovals.mockClear();
        callGatewayFromCli.mockClear();
        defaultRuntime.log.mockClear();
        runtimeLogs.length = 0;
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
