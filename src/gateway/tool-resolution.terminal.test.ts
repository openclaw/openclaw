import { expect, it, vi } from "vitest";
import * as runtimeConfig from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { TerminalSessionManager } from "./terminal/session-manager.js";
import * as pty from "./terminal/session-manager.test-helpers.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

it("preserves exact-session terminal controls while applying configured execution denial", async () => {
  const currentPty = pty.makeFakePty();
  const otherPty = pty.makeFakePty();
  const ptys = [currentPty, otherPty];
  const spawn = vi.fn(async () => ptys.shift() ?? pty.makeFakePty());
  const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
  const childSessionKey = "agent:main:loopback-task-2";
  const open = async (key: string, id?: string) =>
    pty.expectTerminalOpen(
      await manager.open(pty.baseOpenRequest({ owner: pty.agentTerminalOwner(key, id) })),
    ).sessionId;
  const currentId = await open(childSessionKey, "loopback-session-id");
  const otherId = await open("agent:main:loopback-task-1");
  currentPty.emitData("current session output\n");
  const context = { terminalSessions: manager } as unknown as GatewayRequestContext;
  const inScope = <T>(run: () => T) =>
    withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, run);

  const cfg: OpenClawConfig = { tools: { allow: ["terminal"], exec: { mode: "deny" } } };
  runtimeConfig.setRuntimeConfigSnapshot(cfg);
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
      expect(execute(action, { sessionId: otherId, ...params })).rejects.toThrow(
        "Terminal session unavailable",
      );

    await expect(execute("list")).resolves.toMatchObject({
      details: { sessions: [expect.objectContaining({ sessionId: currentId })] },
    });
    await expect(execute("read", { sessionId: currentId })).resolves.toMatchObject({
      details: { sessionId: currentId, text: "current session output\n" },
    });
    await unavailable("read");
    const size = { cols: 100, rows: 30 };
    await unavailable("resize", size);
    await expect(execute("resize", { sessionId: currentId, ...size })).resolves.toMatchObject({
      details: { ok: true },
    });
    expect(currentPty.resizes).toEqual([[100, 30]]);
    spawn.mockClear();
    await expect(execute("open")).rejects.toThrow("terminal action unavailable");
    await expect(execute("input", { sessionId: currentId, data: "unsafe\r" })).rejects.toThrow(
      "Terminal input denied by execution policy",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect([currentPty.writes, otherPty.writes]).toEqual([[], []]);

    await unavailable("close");
    await expect(execute("close", { sessionId: currentId })).resolves.toMatchObject({
      details: { ok: true },
    });
    expect([currentPty.killed, otherPty.killed]).toEqual([true, false]);
  } finally {
    manager.disposeAll();
    runtimeConfig.clearRuntimeConfigSnapshot();
  }
});
