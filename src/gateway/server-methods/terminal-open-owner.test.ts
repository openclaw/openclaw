import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTerminalLaunchPolicy } from "../terminal/launch.js";
import { terminalHandlers } from "./terminal.js";
import { makeTerminalSessionMocks } from "./terminal.test-helpers.js";

vi.mock("../session-utils.js", async () => ({
  ...(await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js")),
  loadGatewaySessionEntryReadOnly: vi.fn(() => ({ entry: { sessionId: "ui-session-id" } })),
}));

function explicitFleet(entries: NonNullable<OpenClawConfig["agents"]>["entries"]): OpenClawConfig {
  return {
    gateway: { terminal: { enabled: true } },
    agents: { ownership: "explicit", entries },
  };
}

async function openOnFleet(params: Record<string, unknown>, config: OpenClawConfig) {
  const policy = createTerminalLaunchPolicy(config);
  const sessions = makeTerminalSessionMocks();
  sessions.open.mockImplementation(async (request: { agentId: string }) => ({
    ok: true as const,
    sessionId: "terminal-1",
    agentId: request.agentId,
    shell: "/bin/zsh",
    cwd: "/work",
  }));
  const respond = vi.fn();
  const resolveTerminalLaunchPolicy = vi.fn((agentId?: string) => policy.resolve(agentId));
  const opts = {
    params,
    respond,
    context: {
      getRuntimeConfig: () => config,
      resolveTerminalLaunchPolicy,
      isTerminalEnabled: () => policy.isEnabled(),
      terminalSessions: sessions,
      nodeRegistry: { invoke: vi.fn(), get: () => undefined },
      isConnectionActive: () => true,
      logGateway: { info: vi.fn() },
    },
    client: { connId: "conn-1", connect: {} },
  } as unknown as Parameters<(typeof terminalHandlers)["terminal.open"]>[0];
  await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
  return { sessions, respond, resolveTerminalLaunchPolicy };
}

function expectRejected(
  respond: ReturnType<typeof vi.fn>,
  message: string,
  sessions: { open: ReturnType<typeof vi.fn> },
) {
  expect(sessions.open).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: ErrorCodes.INVALID_REQUEST,
      message: expect.stringContaining(message),
    }),
  );
}

const twoAgents = explicitFleet({ main: {}, research: {} });

describe("terminal.open explicit ownership", () => {
  it("uses sessionKey as the terminal owner when agentId is omitted", async () => {
    const { sessions, respond, resolveTerminalLaunchPolicy } = await openOnFleet(
      { cols: 80, rows: 24, sessionKey: "agent:research:chat" },
      twoAgents,
    );

    expect(resolveTerminalLaunchPolicy).toHaveBeenCalledWith("research");
    expect(sessions.open).toHaveBeenCalledWith(expect.objectContaining({ agentId: "research" }));
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ agentId: "research" }));
  });

  it("keeps an ownerless explicit fleet fail-closed", async () => {
    const { sessions, respond } = await openOnFleet({ cols: 80, rows: 24 }, twoAgents);
    expectRejected(respond, "no explicit owner", sessions);
  });

  it("does not invent an owner for an unqualified session key", async () => {
    const { sessions, respond } = await openOnFleet(
      { cols: 80, rows: 24, sessionKey: "dashboard" },
      twoAgents,
    );
    expectRejected(respond, "no explicit owner", sessions);
  });

  it("rejects a session key that names a different agent than agentId", async () => {
    const { sessions, respond } = await openOnFleet(
      { cols: 80, rows: 24, agentId: "main", sessionKey: "agent:research:chat" },
      twoAgents,
    );
    expectRejected(respond, "does not match session key agent", sessions);
  });

  it("rejects an unknown session-key agent before creating a shell", async () => {
    const { sessions, respond } = await openOnFleet(
      { cols: 80, rows: 24, sessionKey: "agent:ghost:chat" },
      twoAgents,
    );
    expectRejected(respond, 'unknown agent "ghost"', sessions);
  });

  it("rejects a sandboxed session-key agent before creating a shell", async () => {
    const { sessions, respond } = await openOnFleet(
      { cols: 80, rows: 24, sessionKey: "agent:research:chat" },
      explicitFleet({ main: {}, research: { sandbox: { mode: "all" } } }),
    );
    expectRejected(respond, "sandbox", sessions);
  });
});
