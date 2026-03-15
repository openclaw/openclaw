import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const callGatewayFromCli = vi.fn(
  async (method: string, _opts: unknown, params?: unknown): Promise<Record<string, unknown>> => {
    if (method.endsWith(".get")) {
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

const { runtimeErrors, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

const localSnapshot = {
  path: "/tmp/local-exec-approvals.json",
  exists: true,
  raw: "{}",
  hash: "hash-local",
  file: { version: 1, agents: {} },
};
const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;

function resetLocalSnapshot() {
  localSnapshot.file = { version: 1, agents: {} };
}

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: (method: string, opts: unknown, params?: unknown) =>
    callGatewayFromCli(method, opts, params),
}));

vi.mock("./nodes-cli/rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./nodes-cli/rpc.js")>("./nodes-cli/rpc.js");
  return {
    ...actual,
    resolveNodeId: vi.fn(async () => "node-1"),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../infra/exec-approvals.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  return {
    ...actual,
    readExecApprovalsSnapshot: () => localSnapshot,
    saveExecApprovals: vi.fn(),
  };
});

const { registerExecApprovalsCli } = await import("./exec-approvals-cli.js");
const execApprovals = await import("../infra/exec-approvals.js");

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

  beforeEach(() => {
    resetLocalSnapshot();
    resetRuntimeCapture();
    callGatewayFromCli.mockClear();
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdinIsTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY,
      configurable: true,
    });
  });

  it("routes get command to local, gateway, and node modes", async () => {
    await runApprovalsCommand(["approvals", "get"]);

    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeErrors).toHaveLength(0);
    callGatewayFromCli.mockClear();

    await runApprovalsCommand(["approvals", "get", "--gateway"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith("exec.approvals.get", expect.anything(), {});
    expect(runtimeErrors).toHaveLength(0);
    callGatewayFromCli.mockClear();

    await runApprovalsCommand(["approvals", "get", "--node", "macbook"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith("exec.approvals.node.get", expect.anything(), {
      nodeId: "node-1",
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("defaults allowlist add to wildcard agent", async () => {
    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);
    saveExecApprovals.mockClear();

    await runApprovalsCommand(["approvals", "allowlist", "add", "/usr/bin/uname"]);

    expect(callGatewayFromCli).not.toHaveBeenCalledWith(
      "exec.approvals.set",
      expect.anything(),
      {},
    );
    expect(saveExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          "*": expect.anything(),
        }),
      }),
    );
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

    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);
    saveExecApprovals.mockClear();

    await runApprovalsCommand(["approvals", "allowlist", "remove", "/usr/bin/uname"]);

    expect(saveExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        agents: undefined,
      }),
    );
    expect(runtimeErrors).toHaveLength(0);
  });

  it("rejects trust command in non-interactive mode", async () => {
    await expect(
      runApprovalsCommand(["approvals", "trust", "--minutes", "15", "--yes"]),
    ).rejects.toThrow(/__exit__:1/);
    expect(runtimeErrors.some((entry) => entry.includes("interactive terminal"))).toBe(true);
  });

  it("rejects untrust command from agent sessions", async () => {
    const previousSessionKey = process.env.OPENCLAW_SESSION_KEY;
    process.env.OPENCLAW_SESSION_KEY = "session-from-agent";
    try {
      await expect(runApprovalsCommand(["approvals", "untrust", "--yes"])).rejects.toThrow(
        /__exit__:1/,
      );
      expect(runtimeErrors.some((entry) => entry.includes("blocked from agent sessions"))).toBe(
        true,
      );
      expect(callGatewayFromCli).not.toHaveBeenCalledWith(
        "exec.approvals.untrust",
        expect.anything(),
        expect.anything(),
      );
    } finally {
      if (previousSessionKey === undefined) {
        delete process.env.OPENCLAW_SESSION_KEY;
      } else {
        process.env.OPENCLAW_SESSION_KEY = previousSessionKey;
      }
    }
  });

  it("rejects trust command from agent sessions", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const previousSessionKey = process.env.OPENCLAW_SESSION_KEY;
    process.env.OPENCLAW_SESSION_KEY = "session-from-agent";
    try {
      await expect(
        runApprovalsCommand(["approvals", "trust", "--minutes", "10", "--yes"]),
      ).rejects.toThrow(/__exit__:1/);
      expect(runtimeErrors.some((entry) => entry.includes("blocked from agent sessions"))).toBe(
        true,
      );
      expect(callGatewayFromCli).not.toHaveBeenCalledWith(
        "exec.approvals.trust",
        expect.anything(),
        expect.anything(),
      );
    } finally {
      if (previousSessionKey === undefined) {
        delete process.env.OPENCLAW_SESSION_KEY;
      } else {
        process.env.OPENCLAW_SESSION_KEY = previousSessionKey;
      }
    }
  });

  it("routes trust command to gateway RPC", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    callGatewayFromCli.mockResolvedValueOnce({
      ok: true,
      agentId: "main",
      expiresAt: Date.now() + 10 * 60_000,
    });

    await runApprovalsCommand(["approvals", "trust", "--minutes", "10", "--yes"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "exec.approvals.trust",
      expect.anything(),
      expect.objectContaining({ agentId: "main", minutes: 10, force: false }),
    );
    expect(runtimeErrors).toHaveLength(0);
  });

  it("passes force: true to gateway when --force flag provided", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    callGatewayFromCli.mockResolvedValueOnce({
      ok: true,
      agentId: "main",
      expiresAt: Date.now() + 120 * 60_000,
    });
    await runApprovalsCommand(["approvals", "trust", "--minutes", "90", "--force", "--yes"]);
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "exec.approvals.trust",
      expect.anything(),
      expect.objectContaining({ minutes: 90, force: true }),
    );
  });

  it.each(["10foo", "1.5", "0x20"])(
    "rejects malformed trust minutes value: %s",
    async (minutes) => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      await expect(
        runApprovalsCommand(["approvals", "trust", "--minutes", minutes, "--yes"]),
      ).rejects.toThrow(/__exit__:1/);
      expect(runtimeErrors.some((entry) => entry.includes("minutes must be an integer"))).toBe(
        true,
      );
      expect(callGatewayFromCli).not.toHaveBeenCalledWith(
        "exec.approvals.trust",
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it("routes untrust command to gateway RPC", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ ok: true, agentId: "main", summary: null });

    await runApprovalsCommand(["approvals", "untrust", "--yes"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "exec.approvals.untrust",
      expect.anything(),
      expect.objectContaining({ agentId: "main", keepAudit: false }),
    );
    expect(runtimeErrors).toHaveLength(0);
  });

  it("passes keepAudit: true when --keep-audit flag provided", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ ok: true, agentId: "main", summary: null });
    await runApprovalsCommand(["approvals", "untrust", "--keep-audit", "--yes"]);
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "exec.approvals.untrust",
      expect.anything(),
      expect.objectContaining({ keepAudit: true }),
    );
  });

  it("routes trust-status command to gateway RPC", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ agentId: "main", trustWindow: null });

    await runApprovalsCommand(["approvals", "trust-status"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "exec.approvals.trust.status",
      expect.anything(),
      { agentId: "main" },
    );
    expect(runtimeErrors).toHaveLength(0);
  });
});
