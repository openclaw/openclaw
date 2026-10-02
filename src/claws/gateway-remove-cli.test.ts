import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClawRemoveGatewayBridge } from "./gateway-remove-bridge.js";
import { runClawRemoveCli } from "./gateway-remove-cli.js";

const resolveCurrentOpenClawCliInvocation = vi.hoisted(() => vi.fn());
const runCommandBuffered = vi.hoisted(() => vi.fn());
vi.mock("../infra/openclaw-cli-invocation.js", () => ({ resolveCurrentOpenClawCliInvocation }));
vi.mock("../process/exec.js", () => ({ runCommandBuffered }));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Claw Remove one-shot CLI", () => {
  it("keeps preview and apply child authority separate", async () => {
    const applyBridge: ClawRemoveGatewayBridge = {
      agentId: "worker",
      assertCurrent: () => {},
      allowedCronJobIds: new Set(),
      createCallbacks: () => ({
        monitorGateway: { inspect: async () => [], quiesce: async () => {}, drain: async () => {} },
        packageGateway: async () => ({ packages: [] }),
        cronGateway: { get: async () => null, remove: async () => {} },
      }),
    };
    const previewBridge: ClawRemoveGatewayBridge = {
      previewOnly: true,
      agentId: "worker",
      assertCurrent: () => {},
      monitorGateway: { inspect: async () => [] },
    };
    await expect(
      runClawRemoveCli({ agentId: "worker", gatewayBridge: applyBridge }),
    ).rejects.toThrow("requires the reviewed plan");
    await expect(
      runClawRemoveCli({
        agentId: "worker",
        planIntegrity: `sha256:${"a".repeat(64)}`,
        gatewayBridge: previewBridge,
      }),
    ).rejects.toThrow("preview bridge cannot apply");
    expect(resolveCurrentOpenClawCliInvocation).not.toHaveBeenCalled();
  });

  it("passes only the agent and canonical digest as argv, with bounded output", async () => {
    resolveCurrentOpenClawCliInvocation.mockImplementation((args) => ({
      command: "/usr/bin/node",
      args: ["/app/openclaw.mjs", ...args],
      cwd: "/app",
      env: { TSX_TSCONFIG_PATH: "/app/tsconfig.json" },
    }));
    runCommandBuffered.mockResolvedValue({
      termination: "exit",
      code: 0,
      stdout: Buffer.from('{"status":"complete"}'),
    });
    const digest = `sha256:${"a".repeat(64)}`;
    const gatewayBridge: ClawRemoveGatewayBridge = {
      agentId: "worker",
      assertCurrent: () => {},
      allowedCronJobIds: new Set(),
      createCallbacks: () => ({
        monitorGateway: { inspect: async () => [], quiesce: async () => {}, drain: async () => {} },
        packageGateway: async () => ({ packages: [] }),
        cronGateway: { get: async () => null, remove: async () => {} },
      }),
    };
    expect(
      await runClawRemoveCli({ agentId: "worker", planIntegrity: digest, gatewayBridge }),
    ).toEqual({ code: 0, payload: { status: "complete" } });
    expect(resolveCurrentOpenClawCliInvocation).toHaveBeenCalledWith(
      [
        "claws",
        "remove",
        "worker",
        "--exact-agent-id",
        "--yes",
        "--plan-integrity",
        digest,
        "--json",
      ],
      { moduleUrl: expect.any(String) },
    );
    expect(runCommandBuffered).toHaveBeenCalledWith(
      [
        "/usr/bin/node",
        "/app/openclaw.mjs",
        "claws",
        "remove",
        "worker",
        "--exact-agent-id",
        "--yes",
        "--plan-integrity",
        digest,
        "--json",
      ],
      expect.objectContaining({
        cwd: "/app",
        env: {
          TSX_TSCONFIG_PATH: "/app/tsconfig.json",
          OPENCLAW_CLAW_REMOVE_GATEWAY_BRIDGE: "1",
          OPENCLAW_NO_RESPAWN: "1",
          NODE_DISABLE_COMPILE_CACHE: "1",
        },
        onPrivateControlChild: expect.any(Function),
        timeoutMs: 600_000,
        killGraceMs: 5_000,
        killProcessTree: true,
        maxOutputBytes: { stdout: 8 * 1024 * 1024, stderr: 64 * 1024 },
      }),
    );
  });

  it("does not leak stderr or malformed child output in errors", async () => {
    resolveCurrentOpenClawCliInvocation.mockReturnValue({
      command: "/usr/bin/node",
      args: ["/app/openclaw.mjs"],
      cwd: "/app",
    });
    runCommandBuffered
      .mockResolvedValueOnce({
        termination: "timeout",
        code: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("private token"),
      })
      .mockResolvedValueOnce({
        termination: "exit",
        code: 1,
        stdout: Buffer.from("private token"),
        stderr: Buffer.from("private token"),
      });
    await expect(runClawRemoveCli({ agentId: "worker" })).rejects.toThrow(
      "The Claw removal command did not complete.",
    );
    expect(runCommandBuffered.mock.calls[0]?.[1]?.env).toMatchObject({
      OPENCLAW_CLAW_REMOVE_GATEWAY_BRIDGE: "0",
    });
    expect(runCommandBuffered.mock.calls[0]?.[1]?.onPrivateControlChild).toBeUndefined();
    await expect(runClawRemoveCli({ agentId: "worker" })).rejects.toThrow(
      "The Claw removal command returned an invalid result.",
    );
  });
});
