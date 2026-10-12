import { vi } from "vitest";
import type { TerminalUploadResult } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTerminalLaunchPolicy } from "../terminal/launch.js";
import type { TerminalSessionSummary } from "../terminal/session-types.js";
import type { terminalHandlers } from "./terminal.js";

function makeTerminalSessionMocks() {
  return {
    open: vi.fn(async (_request: unknown) => ({
      ok: true as const,
      sessionId: "terminal-1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
    })),
    write: vi.fn(() => true),
    resize: vi.fn(() => true),
    close: vi.fn(() => true),
    attach: vi.fn(() => ({
      sessionId: "terminal-1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      buffer: "replay",
      seq: 6,
      title: "codex",
      owner: "conn" as const,
    })),
    snapshot: vi.fn(() => "10%\r100%"),
    list: vi.fn((): TerminalSessionSummary[] => []),
    upload: vi.fn(async (): Promise<TerminalUploadResult> => ({
      path: "/tmp/upload/report.pdf",
      size: 4,
    })),
  };
}

export function makeTerminalGatewayOpts(
  params: unknown,
  terminalConfig: { enabled?: boolean } | undefined,
  terminalPolicyConfig?: OpenClawConfig,
  nodeRegistry: {
    get: (nodeId: string) => unknown;
    invoke?: (params: unknown) => Promise<unknown>;
  } = { get: () => undefined },
) {
  const sessions = makeTerminalSessionMocks();
  const runtimeConfig: OpenClawConfig = { gateway: { terminal: terminalConfig } };
  const policy = createTerminalLaunchPolicy(runtimeConfig);
  if (terminalPolicyConfig) {
    policy.prepareConfig(terminalPolicyConfig, { restartPending: true });
  }
  const respond = vi.fn();
  const isConnectionActive = vi.fn(() => true);
  const isTerminalEnabled = vi.fn(() => policy.isEnabled());
  const resolveTerminalLaunchPolicy = vi.fn((agentId?: string) => policy.resolve(agentId));
  const context = {
    getRuntimeConfig: () => runtimeConfig,
    resolveTerminalLaunchPolicy,
    isTerminalEnabled,
    terminalSessions: sessions,
    nodeRegistry: { invoke: vi.fn(), ...nodeRegistry },
    isConnectionActive,
    logGateway: { info: vi.fn() },
  } as unknown as Parameters<(typeof terminalHandlers)["terminal.input"]>[0]["context"];
  const opts = {
    params: params as Record<string, unknown>,
    respond,
    context,
    client: { connId: "conn-1", connect: {} },
  } as unknown as Parameters<(typeof terminalHandlers)["terminal.input"]>[0];
  return {
    opts,
    sessions,
    respond,
    isConnectionActive,
    isTerminalEnabled,
    resolveTerminalLaunchPolicy,
    runtimeConfig,
  };
}
