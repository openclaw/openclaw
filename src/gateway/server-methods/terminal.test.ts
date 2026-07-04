import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveTerminalLaunch } from "../terminal/launch.js";
import { terminalHandlers } from "./terminal.js";

function makeOpts(
  params: unknown,
  terminalConfig: { enabled?: boolean } | undefined,
  terminalPolicyConfig?: OpenClawConfig,
) {
  const sessions = {
    open: vi.fn(),
    write: vi.fn(() => true),
    resize: vi.fn(() => true),
    close: vi.fn(() => true),
  };
  const respond = vi.fn();
  const runtimeConfig = { gateway: { terminal: terminalConfig } } as OpenClawConfig;
  const policyConfig = terminalPolicyConfig ?? runtimeConfig;
  const context = {
    getRuntimeConfig: () => runtimeConfig,
    resolveTerminalLaunchPolicy: (agentId?: string) =>
      resolveTerminalLaunch({
        config: policyConfig,
        enabled: policyConfig.gateway?.terminal?.enabled === true,
        agentId,
        configuredShell: policyConfig.gateway?.terminal?.shell,
      }),
    isTerminalEnabled: () => policyConfig.gateway?.terminal?.enabled === true,
    terminalSessions: sessions,
    // Only the fields the terminal handlers touch are needed here.
  } as unknown as Parameters<(typeof terminalHandlers)["terminal.input"]>[0]["context"];
  const opts = {
    params: params as Record<string, unknown>,
    respond,
    context,
    client: { connId: "conn-1", connect: {} },
  } as unknown as Parameters<(typeof terminalHandlers)["terminal.input"]>[0];
  return { opts, sessions, respond };
}

describe("terminal.open policy snapshot", () => {
  it("rejects reopening after an accepted disable while runtime restart is pending", async () => {
    const { opts, sessions, respond } = makeOpts(
      { cols: 80, rows: 24 },
      { enabled: true },
      { gateway: { terminal: { enabled: false } } },
    );

    await terminalHandlers["terminal.open"](opts);

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });

  it("rejects reopening after an accepted sandbox tightening", async () => {
    const { opts, sessions, respond } = makeOpts(
      { cols: 80, rows: 24 },
      { enabled: true },
      {
        gateway: { terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
    );

    await terminalHandlers["terminal.open"](opts);

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });
});

describe("terminal.input kill switch", () => {
  it("writes to the session when the terminal is enabled", async () => {
    const { opts, sessions, respond } = makeOpts(
      { sessionId: "s1", data: "ls\n" },
      { enabled: true },
    );
    await terminalHandlers["terminal.input"](opts);
    expect(sessions.write).toHaveBeenCalledWith("conn-1", "s1", "ls\n");
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("closes the session and rejects input when the terminal is disabled", async () => {
    const { opts, sessions, respond } = makeOpts(
      { sessionId: "s1", data: "ls\n" },
      { enabled: false },
    );
    await terminalHandlers["terminal.input"](opts);
    // The disabled kill switch must stop live input and tear the session down.
    expect(sessions.write).not.toHaveBeenCalled();
    expect(sessions.close).toHaveBeenCalledWith("conn-1", "s1");
    expect(respond).toHaveBeenCalledWith(true, { ok: false });
  });

  it("defaults to disabled when terminal config is absent", async () => {
    const { opts, sessions, respond } = makeOpts({ sessionId: "s1", data: "ls\n" }, undefined);
    await terminalHandlers["terminal.input"](opts);
    expect(sessions.write).not.toHaveBeenCalled();
    expect(sessions.close).toHaveBeenCalledWith("conn-1", "s1");
    expect(respond).toHaveBeenCalledWith(true, { ok: false });
  });
});

describe("terminal.resize kill switch", () => {
  it("rejects and closes when disabled", async () => {
    const { opts, sessions, respond } = makeOpts(
      { sessionId: "s1", cols: 80, rows: 24 },
      { enabled: false },
    );
    await terminalHandlers["terminal.resize"](opts);
    expect(sessions.resize).not.toHaveBeenCalled();
    expect(sessions.close).toHaveBeenCalledWith("conn-1", "s1");
    expect(respond).toHaveBeenCalledWith(true, { ok: false });
  });
});
