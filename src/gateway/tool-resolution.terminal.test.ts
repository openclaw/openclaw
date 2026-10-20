import { expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { TerminalSessionManager } from "./terminal/session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  expectTerminalOpen,
  makeFakePty,
} from "./terminal/session-manager.test-helpers.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

it("preserves exact-session terminal controls while applying configured execution denial", async () => {
  const currentPty = makeFakePty();
  const otherPty = makeFakePty();
  const ptys = [currentPty, otherPty];
  const spawn = vi.fn(async () => ptys.shift() ?? makeFakePty());
  const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
  const childSessionKey = "agent:main:loopback-task-2";
  const open = async (key: string, id?: string) =>
    expectTerminalOpen(await manager.open(baseOpenRequest({ owner: agentTerminalOwner(key, id) })));
  const current = await open(childSessionKey, "loopback-session-id");
  const other = await open("agent:main:loopback-task-1");
  currentPty.emitData("current session output\n");
  const context = { terminalSessions: manager } as unknown as GatewayRequestContext;
  const inScope = <T>(run: () => T) =>
    withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, run);

  const cfg: OpenClawConfig = { tools: { allow: ["terminal"], exec: { mode: "deny" } } };
  setRuntimeConfigSnapshot(cfg);
  try {
    const result = await inScope(() =>
      resolveGatewayScopedTools({
        cfg,
        sessionKey: childSessionKey,
        sessionId: "loopback-session-id",
        execSession: { permissionMode: "read-only" },
        runId: "shared-run",
        senderIsOwner: true,
        surface: "loopback",
      }),
    );
    const terminal = result.tools.find((tool) => tool.name === "terminal");
    if (!terminal?.execute) {
      throw new Error("expected loopback terminal tool");
    }
    const execute = (action: string, params: Record<string, unknown> = {}) =>
      inScope(() => terminal.execute!("terminal-tool", { action, ...params }));
    const unavailable = (action: string, params: Record<string, unknown> = {}) =>
      expect(execute(action, { sessionId: other.sessionId, ...params })).rejects.toThrow(
        "Terminal session unavailable",
      );

    await expect(execute("list")).resolves.toMatchObject({
      details: { sessions: [expect.objectContaining({ sessionId: current.sessionId })] },
    });
    await expect(execute("read", { sessionId: current.sessionId })).resolves.toMatchObject({
      details: { sessionId: current.sessionId, text: "current session output\n" },
    });
    await unavailable("read");
    await unavailable("resize", { cols: 100, rows: 30 });
    await expect(
      execute("resize", { sessionId: current.sessionId, cols: 100, rows: 30 }),
    ).resolves.toMatchObject({ details: { ok: true } });
    expect(currentPty.resizes).toEqual([[100, 30]]);
    spawn.mockClear();
    await expect(execute("open")).rejects.toThrow("terminal action unavailable");
    await expect(
      execute("input", { sessionId: current.sessionId, data: "unsafe\r" }),
    ).rejects.toThrow("Terminal input denied by execution policy");
    expect(spawn).not.toHaveBeenCalled();
    expect(currentPty.writes).toEqual([]);
    expect(otherPty.writes).toEqual([]);

    await unavailable("close");
    await expect(execute("close", { sessionId: current.sessionId })).resolves.toMatchObject({
      details: { ok: true },
    });
    expect(currentPty.killed).toBe(true);
    expect(otherPty.killed).toBe(false);
  } finally {
    manager.disposeAll();
    clearRuntimeConfigSnapshot();
  }
});
