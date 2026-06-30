import { EventEmitter } from "node:events";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnedChild = Object.assign(new EventEmitter(), { kill: vi.fn() });
vi.mock("node:child_process", () => ({ spawn: vi.fn(() => spawnedChild) }));

// The node conduit is lazy-imported on the node path; mock it so we can assert routing + teardown.
const nodeClose = vi.fn(async () => {});
const nodeAttachMock = vi.fn(async () => ({
  sessionKey: "agent:main:node",
  mcpConfig: { mcpServers: { openclaw: { type: "http", url: "http://127.0.0.1:7777/mcp" } } },
  env: { OPENCLAW_MCP_TOKEN: "node-tok" },
  launchArgs: ["--resume", "sid-node"],
  close: nodeClose,
}));
vi.mock("./node-cli/attach.js", () => ({ runNodeAttach: nodeAttachMock }));

const gatewayCalls: Array<{
  method: string;
  params: Record<string, unknown>;
  mode?: string;
  hasDeviceIdentityKey: boolean;
}> = [];
vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(
    async (p: { method: string; params: Record<string, unknown>; mode?: string }) => {
      gatewayCalls.push({
        method: p.method,
        params: p.params,
        mode: p.mode,
        hasDeviceIdentityKey: "deviceIdentity" in p,
      });
      if (p.method === "attach.grant") {
        const sessionKey = (p.params.sessionKey as string) ?? "agent:main:main";
        return {
          sessionKey,
          token: "tok-123",
          expiresAtMs: 2_000_000_000_000,
          mcpConfig: {
            mcpServers: {
              openclaw: {
                type: "http",
                url: "http://127.0.0.1:9999/mcp",
                headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
              },
            },
          },
          env: { OPENCLAW_MCP_TOKEN: "tok-123", OPENCLAW_MCP_SESSION_KEY: sessionKey },
        };
      }
      return {};
    },
  ),
}));

const logs: string[] = [];
let exitCode: number | undefined;
vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (m: string) => logs.push(m),
    error: (m: string) => logs.push(`ERR:${m}`),
    exit: (c: number) => {
      exitCode = c;
    },
  },
}));
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));

import { spawn } from "node:child_process";
import { callGateway } from "../gateway/call.js";
import { registerAttachCli } from "./attach-cli.js";

async function runAttach(...args: string[]) {
  const program = new Command().name("openclaw").exitOverride();
  await registerAttachCli(program);
  await program.parseAsync(["node", "openclaw", "attach", ...args]);
}
const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe("openclaw attach (action)", () => {
  beforeEach(() => {
    gatewayCalls.length = 0;
    logs.length = 0;
    exitCode = undefined;
    spawnedChild.removeAllListeners();
    spawnedChild.kill.mockClear();
    nodeAttachMock.mockClear();
    nodeClose.mockClear();
    vi.mocked(spawn).mockClear();
  });

  it("--print-config: mints + writes config + prints launch, does NOT revoke or name a nonexistent command", async () => {
    await runAttach("--print-config", "--session", "agent:main:cli");
    expect(gatewayCalls.find((c) => c.method === "attach.grant")?.params.sessionKey).toBe(
      "agent:main:cli",
    );
    // setup mode leaves the grant live (no revoke) and must not point at a revoke command that does not exist
    expect(gatewayCalls.find((c) => c.method === "attach.revoke")).toBeUndefined();
    const out = logs.join("\n");
    expect(out).toContain("agent:main:cli");
    expect(out).toContain("--mcp-config");
    expect(out).toContain("OPENCLAW_MCP_TOKEN");
    expect(out).not.toContain("attach.revoke");
  });

  it("calls attach.grant in CLI mode with an auto-resolved device identity (operator.admin regression guard)", async () => {
    // Regression guard: attach.grant is operator.admin-scoped. mode BACKEND or an explicit
    // deviceIdentity:null drops the operator device identity → the gateway rejects with
    // "missing scope: operator.admin". This was a real bug found via a live-gateway proof.
    await runAttach("--print-config", "--session", "agent:main:cli");
    const grant = gatewayCalls.find((c) => c.method === "attach.grant");
    expect(grant?.mode).toBe("cli");
    expect(grant?.hasDeviceIdentityKey).toBe(false);
  });

  it("rejects a non-positive --ttl before minting", async () => {
    await runAttach("--ttl", "-5", "--print-config");
    expect(exitCode).toBe(1);
    expect(gatewayCalls.find((c) => c.method === "attach.grant")).toBeUndefined();
  });

  it("rejects an empty --ttl rather than silently defaulting", async () => {
    await runAttach("--ttl", "", "--print-config");
    expect(exitCode).toBe(1);
    expect(gatewayCalls.find((c) => c.method === "attach.grant")).toBeUndefined();
  });

  it("passes a positive --ttl through to attach.grant", async () => {
    await runAttach("--ttl", "600000", "--print-config");
    expect(gatewayCalls.find((c) => c.method === "attach.grant")?.params.ttlMs).toBe(600_000);
  });

  it("errors on a malformed attach.grant response instead of crashing", async () => {
    vi.mocked(callGateway).mockResolvedValueOnce({} as never);
    await runAttach("--print-config");
    expect(exitCode).toBe(1);
  });

  it("spawns Claude Code and revokes the grant when the child exits", async () => {
    await runAttach("--session", "agent:main:spawn"); // spawn path (no --print-config)
    expect(gatewayCalls.find((c) => c.method === "attach.grant")).toBeTruthy();
    spawnedChild.emit("exit", 0, null);
    await tick();
    await tick();
    expect(gatewayCalls.find((c) => c.method === "attach.revoke")?.params.token).toBe("tok-123");
    expect(exitCode).toBe(0);
  });

  it("revokes once and surfaces a launch failure when the child errors", async () => {
    await runAttach("--session", "agent:main:spawn-err");
    spawnedChild.emit("error", new Error("ENOENT"));
    await tick();
    await tick();
    expect(gatewayCalls.filter((c) => c.method === "attach.revoke")).toHaveLength(1);
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Failed to launch");
  });

  it("detaches its signal handlers after the child exits (no listener leak)", async () => {
    const baseInt = process.listenerCount("SIGINT");
    const baseTerm = process.listenerCount("SIGTERM");
    await runAttach("--session", "agent:main:spawn");
    expect(process.listenerCount("SIGINT")).toBe(baseInt + 1);
    spawnedChild.emit("exit", 0, null);
    await tick();
    await tick();
    expect(process.listenerCount("SIGINT")).toBe(baseInt);
    expect(process.listenerCount("SIGTERM")).toBe(baseTerm);
  });

  it("errors on a grant with a non-numeric expiresAtMs instead of crashing on toISOString", async () => {
    vi.mocked(callGateway).mockResolvedValueOnce({
      sessionKey: "agent:main:x",
      token: "tok-123",
      expiresAtMs: "soon",
      mcpConfig: { mcpServers: { openclaw: {} } },
      env: {},
    } as never);
    await runAttach("--print-config");
    expect(exitCode).toBe(1);
  });

  it("--via node uses the conduit (no attach.grant) and spawns with the hydration --resume args", async () => {
    await runAttach("--via", "node");
    expect(nodeAttachMock).toHaveBeenCalledTimes(1);
    expect(gatewayCalls.find((c) => c.method === "attach.grant")).toBeUndefined();
    const spawnArgs = vi.mocked(spawn).mock.calls.at(-1)?.[1];
    expect(spawnArgs).toEqual(["--mcp-config", expect.any(String), "--resume", "sid-node"]);
    // the conduit (forwarder + node link) is torn down on child exit
    spawnedChild.emit("exit", 0, null);
    await tick();
    await tick();
    expect(nodeClose).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(0);
  });

  it("--via node rejects --print-config (the in-process forwarder can't outlive it)", async () => {
    await runAttach("--via", "node", "--print-config");
    expect(exitCode).toBe(1);
    expect(nodeAttachMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid --via without minting or connecting", async () => {
    await runAttach("--via", "carrier-pigeon");
    expect(exitCode).toBe(1);
    expect(gatewayCalls.find((c) => c.method === "attach.grant")).toBeUndefined();
    expect(nodeAttachMock).not.toHaveBeenCalled();
  });

  it("--via auto falls back to the node conduit when the gateway-host grant fails", async () => {
    vi.mocked(callGateway).mockRejectedValueOnce(new Error("missing scope: operator.admin"));
    await runAttach(); // auto
    expect(nodeAttachMock).toHaveBeenCalledTimes(1);
    spawnedChild.emit("exit", 0, null);
    await tick();
    await tick();
  });
});
