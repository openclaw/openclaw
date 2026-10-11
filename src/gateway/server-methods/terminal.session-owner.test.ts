import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { TerminalSessionManager } from "../terminal/session-manager.js";
import { makeFakePty } from "../terminal/session-manager.test-helpers.js";
import { openTerminalSession, terminalHandlers } from "./terminal.js";
import { makeTerminalGatewayOpts as makeOpts } from "./terminal.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const sessionMocks = vi.hoisted(() => ({
  loadGatewaySessionEntryReadOnly: vi.fn(
    (
      _sessionKey: string,
      _opts?: unknown,
    ): {
      entry?: Pick<InternalSessionEntry, "sessionId" | "pendingProjectGitUrl" | "pendingWorktree">;
    } => ({
      entry: { sessionId: "ui-session-id" },
    }),
  ),
}));

vi.mock("../session-utils.js", async () => ({
  ...(await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js")),
  loadGatewaySessionEntryReadOnly: sessionMocks.loadGatewaySessionEntryReadOnly,
}));

afterEach(() => {
  sessionMocks.loadGatewaySessionEntryReadOnly.mockReset().mockReturnValue({
    entry: { sessionId: "ui-session-id" },
  });
});

describe("terminal session ownership", () => {
  it.each([
    { name: "a qualified session", params: { sessionKey: "agent:research:ui-session" } },
    {
      name: "a qualified session with its agent",
      params: { agentId: "research", sessionKey: "agent:research:ui-session" },
    },
  ])("binds a UI terminal to the owner's workspace for $name", async ({ params }) => {
    const backend = makeFakePty();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => backend });
    onTestFinished(() => manager.disposeAll());
    const workspace = tempDirs.make("terminal-session-owner-");
    const agentSessionKey = "agent:research:ui-session";
    const agentOwner = {
      kind: "agent",
      agentSessionKey,
      agentSessionId: "ui-session-id",
      agentId: "research",
    } as const;
    const { opts, respond, runtimeConfig } = makeOpts(
      { ...params, cols: 80, rows: 24 },
      { enabled: true },
    );
    runtimeConfig.agents = {
      ownership: "explicit",
      entries: { main: {}, research: { workspace } },
    };
    opts.context.terminalSessions = manager;

    await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        agentId: "research",
        cwd: workspace,
        sessionId: expect.any(String),
      }),
    );
    const owned = manager.listAgent(agentOwner);
    expect(owned).toHaveLength(1);
    const session = expectDefined(owned[0], "session-owned UI terminal");
    expect(session).toMatchObject({ attached: true, owner: `agent:${agentSessionKey}` });
    expect(manager.write("conn-1", session.sessionId, "operator input\n")).toBe(true);

    backend.emitData("ui session output");
    expect(manager.snapshotAgent(agentOwner, session.sessionId)).toContain("ui session output");
    expect(
      manager.listAgent({ ...agentOwner, agentSessionKey: "agent:research:other-session" }),
    ).toEqual([]);
    expect(
      manager.snapshotAgent({ ...agentOwner, agentId: "main" }, session.sessionId),
    ).toBeUndefined();
    expect(sessionMocks.loadGatewaySessionEntryReadOnly).toHaveBeenCalledWith(agentSessionKey, {
      agentId: "research",
      clone: false,
    });
  });

  it.each([
    { state: "is missing", entry: undefined, error: { code: ErrorCodes.UNAVAILABLE } },
    {
      state: "awaits worktree preparation",
      entry: {
        sessionId: "ui-session-id",
        pendingWorktree: {
          workspace: "/tmp/project",
          titleSource: "Prepare workspace",
        },
      },
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message:
          'Session "agent:main:pending" workspace is not ready. Wait for setup to finish or retry in chat.',
      },
    },
  ])("rejects UI ownership when the session $state", async ({ entry, error }) => {
    sessionMocks.loadGatewaySessionEntryReadOnly.mockReturnValue({ entry });
    const { opts, sessions, respond } = makeOpts({}, { enabled: true });

    await openTerminalSession(opts, {
      agentId: "main",
      sessionKey: "agent:main:pending",
      cols: 80,
      rows: 24,
    });

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
  });

  it.each([
    {
      name: "missing owner",
      params: {},
      systemAgentId: "main",
      message: /no explicit owner/,
    },
    {
      name: "unqualified session despite a system agent",
      params: { sessionKey: "main" },
      systemAgentId: "main",
      message: /no explicit owner/,
    },
    {
      name: "mismatched owner",
      params: { agentId: "main", sessionKey: "agent:research:ui-session" },
      message: /does not match session key agent/,
    },
    {
      name: "unknown owner",
      params: { sessionKey: "agent:missing:ui-session" },
      message: /unknown agent "missing"/,
    },
    {
      name: "sandboxed owner",
      params: { sessionKey: "agent:research:ui-session" },
      message: /runs in a sandbox/,
    },
  ])("rejects $name before creating a terminal", async ({ params, message, systemAgentId }) => {
    const { opts, sessions, respond, runtimeConfig } = makeOpts(
      { cols: 80, rows: 24, ...params },
      { enabled: true },
    );
    runtimeConfig.agents = {
      ownership: "explicit",
      ...(systemAgentId ? { defaults: { systemAgent: { agentId: systemAgentId } } } : {}),
      entries: { main: {}, research: { sandbox: { mode: "all" } } },
    };

    await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringMatching(message),
      }),
    );
  });
});
