import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as globals from "../../globals.js";
import {
  enqueueSystemEventEntry,
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";

const { cancelExec, createExec, getFinished, getRunning } = vi.hoisted(() => ({
  cancelExec: vi.fn(),
  createExec: vi.fn(),
  getRunning: vi.fn(),
  getFinished: vi.fn(),
}));

vi.mock("../../agents/bash-process-control.js", () => ({
  cancelBackgroundExecSession: cancelExec,
}));

vi.mock("../../agents/bash-process-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/bash-process-registry.js")>()),
  getSession: getRunning,
  getFinishedSession: getFinished,
}));

vi.mock("../../agents/bash-tools.js", () => ({
  createExecTool: createExec,
}));

const { handleBashChatCommand } = await import("./bash-command.js");

function bash(
  commandText: string,
  overrides: Partial<Parameters<typeof handleBashChatCommand>[0]> = {},
) {
  return handleBashChatCommand({
    cfg: { commands: { bash: true } },
    sessionKey: "session-key",
    isGroup: false,
    elevated: { enabled: true, allowed: true, failures: [] },
    ...overrides,
    ctx: { CommandBody: commandText, commandText, SessionKey: "session-key", ...overrides.ctx },
  });
}

function mockExec(result: unknown) {
  const execute = vi.fn().mockResolvedValue(result);
  createExec.mockReturnValue({ execute });
  return execute;
}

function buildRunningSession(overrides?: Record<string, unknown>) {
  return {
    id: "session-1",
    scopeKey: "chat:bash",
    backgrounded: true,
    exited: false,
    ...overrides,
  };
}

function backgroundExecResult(sessionId: string) {
  return {
    content: [],
    details: { status: "running", sessionId, startedAt: Date.now() },
  };
}

describe("handleBashChatCommand", () => {
  afterEach(() => resetSystemEventsForTest());

  beforeEach(() => {
    getRunning.mockReset();
    getFinished.mockReset();
    cancelExec.mockReset().mockReturnValue(true);
    createExec.mockReset();
  });

  it("logs the background session without logging its command", async () => {
    using log = vi.spyOn(globals, "logVerbose").mockImplementation(() => {});
    const execute = mockExec(backgroundExecResult("private-job"));

    const result = await bash("/bash echo PRIVATE_COMMAND_123");

    expect(execute).toHaveBeenCalledWith(
      "chat-bash",
      expect.objectContaining({ command: "echo PRIVATE_COMMAND_123" }),
    );
    expect(result.text).toContain("session private-job");
    expect(log).toHaveBeenCalledWith("Started bash session private-job");
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_COMMAND_123");
  });

  it.each([
    { status: "completed", exitCode: 1, exitSignal: null, label: "code 1" },
    { status: "failed", exitCode: null, exitSignal: "SIGTERM", label: "signal SIGTERM" },
  ])("reports foreground $status as $label without losing diagnostics", async (outcome) => {
    mockExec({
      content: [{ type: "text", text: "execution diagnostic" }],
      details: { ...outcome, aggregated: "execution diagnostic" },
    });

    const result = await bash("/bash command");

    expect(result.text).toContain(`Exit: ${outcome.label}`);
    expect(result.text).toContain("execution diagnostic");
  });

  it("reports a retained process's unknown exit code without acknowledging delivery", async () => {
    const eventOptions = {
      sessionKey: "agent:main:session-key",
      contextKey: "exec:finished-status",
    };
    const previous = enqueueSystemEventEntry("retained diagnostic", eventOptions);
    getFinished.mockReturnValue({
      id: "finished-status",
      scopeKey: "chat:bash",
      terminalStatus: "failed",
      aggregated: "retained diagnostic",
      notifyOnExitRemoval: enqueueSystemEventWithReceipt("retained diagnostic", eventOptions, {
        allowDuplicate: true,
      }),
      exitCode: null,
      exitSignal: null,
    });
    expect(peekSystemEventEntries(eventOptions.sessionKey)).toHaveLength(2);

    const result = await bash("!poll finished-status");

    expect(result.text).toContain("Exit: unknown exit code");
    expect(result.text).toContain("retained diagnostic");
    expect(peekSystemEventEntries(eventOptions.sessionKey)).toHaveLength(2);
    expect(peekSystemEventEntries(eventOptions.sessionKey)).toContainEqual(previous);

    await bash("!poll finished-status");
    expect(peekSystemEventEntries(eventOptions.sessionKey)).toHaveLength(2);
  });

  it("returns no-running-job when session is not found", async () => {
    const result = await bash("/bash stop session-1");

    expect(result.text).toContain("No running bash job found");
    expect(cancelExec).not.toHaveBeenCalled();
  });

  it("does not split boundary emoji in missing session snippets", async () => {
    const result = await bash("/bash stop 1234567😀tail");

    expect(result.text).toBe("⚙️ No running bash job found for 1234567….");
  });

  it("returns actionable guidance when canonical cancellation is not admitted", async () => {
    const session = buildRunningSession();
    getRunning.mockReturnValue(session);
    cancelExec.mockReturnValue(false);

    const result = await bash("/bash stop session-1");

    expect(result.text).toContain("Unable to stop bash session");
    expect(result.text).toContain("!poll session-1");
    expect(result.text).toContain("no active cancellation handle");
    expect(cancelExec).toHaveBeenCalledWith("session-1");
  });

  it("clears active job state from registry lifecycle without a child watcher", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(backgroundExecResult("session-first"))
      .mockResolvedValueOnce(backgroundExecResult("session-second"));
    createExec.mockReturnValue({ execute });

    await bash("/bash first");
    const firstSession = buildRunningSession({ id: "session-first" });
    getRunning.mockReturnValue(firstSession);
    await bash("/bash stop");
    expect(cancelExec).toHaveBeenCalledWith("session-first");
    expect(firstSession.exited).toBe(false);

    getRunning.mockReturnValue(undefined);
    getFinished.mockReturnValue({
      id: "session-first",
      scopeKey: "chat:bash",
      terminalStatus: "failed",
    });
    const restarted = await bash("/bash second");
    expect(restarted.text).toContain("session-second");
    expect(execute).toHaveBeenCalledTimes(2);

    getFinished.mockReturnValue(undefined);
    await bash("/bash help");
  });

  it("passes the global session's prepared owner to exec", async () => {
    mockExec({ content: [], details: { status: "completed", exitCode: 0, aggregated: "done" } });
    const result = await bash("/bash echo done", {
      agentId: "target",
      sessionKey: "global",
      ctx: {
        RuntimePolicySessionKey: "agent:main:telegram:direct:policy-session",
      },
    });

    expect(result.text).toContain("Exit: code 0");
    expect(createExec).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "target", sessionKey: "global" }),
    );
  });

  it.each([
    { sessionKey: "global", policySessionKey: undefined, runtime: "sandboxed" },
    {
      sessionKey: "global",
      policySessionKey: "agent:main:telegram:direct:policy-session",
      runtime: "direct",
    },
  ])(
    "explains elevated denial for $sessionKey with policy $policySessionKey",
    async ({ sessionKey, policySessionKey, runtime }) => {
      await withStateDirEnv("bash-denied-owner-", async () => {
        const result = await bash("/bash pwd", {
          agentId: "target",
          sessionKey,
          ctx: {
            SessionKey: "agent:main:telegram:slash-session",
            RuntimePolicySessionKey: policySessionKey,
          },
          elevated: { enabled: true, allowed: false, failures: [] },
          cfg: {
            commands: { bash: true },
            agents: {
              ownership: "explicit",
              entries: {
                target: { sandbox: { mode: "all" } },
                main: { sandbox: { mode: "off" } },
              },
            },
          },
        });

        expect(result.text).toContain(`elevated is not available right now (runtime=${runtime})`);
        expect(result.text).toContain(`openclaw sandbox explain --session ${sessionKey}`);
        expect(result.text).not.toContain("agent:main:telegram:slash-session");
        expect(createExec).not.toHaveBeenCalled();
      });
    },
  );
});
