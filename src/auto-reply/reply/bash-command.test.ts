import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { MsgContext } from "../templating.js";

const { createExecToolMock, execExecuteMock, getFinishedSessionMock, getSessionMock } = vi.hoisted(
  () => ({
    createExecToolMock: vi.fn(),
    execExecuteMock: vi.fn(),
    getFinishedSessionMock: vi.fn(),
    getSessionMock: vi.fn(),
  }),
);

vi.mock("../../agents/bash-process-registry.js", () => ({
  getSession: getSessionMock,
  getFinishedSession: getFinishedSessionMock,
  markExited: vi.fn(),
}));

vi.mock("../../agents/bash-tools.js", () => ({
  createExecTool: createExecToolMock,
}));

const { handleBashChatCommand, resetBashChatCommandForTests } = await import("./bash-command.js");

function buildRunParams(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionEntry?: SessionEntry;
}) {
  const ctx = {
    CommandBody: "/bash echo ok",
    SessionKey: "agent:ops:whatsapp:direct:user-1",
  } as MsgContext;

  return {
    ctx,
    cfg: params.cfg,
    agentId: params.agentId,
    sessionEntry: params.sessionEntry,
    sessionKey: "agent:ops:whatsapp:direct:user-1",
    isGroup: false,
    elevated: {
      enabled: true,
      allowed: true,
      failures: [],
    },
  };
}

describe("handleBashChatCommand exec defaults", () => {
  beforeEach(() => {
    resetBashChatCommandForTests();
    vi.clearAllMocks();
    getSessionMock.mockReturnValue(undefined);
    getFinishedSessionMock.mockReturnValue(undefined);
    createExecToolMock.mockReturnValue({ execute: execExecuteMock });
    execExecuteMock.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      details: {
        status: "completed",
        exitCode: 0,
        durationMs: 2,
        aggregated: "ok",
      },
    });
  });

  it("builds chat bash exec defaults from effective global, agent, and session policy", async () => {
    const cfg = {
      commands: { bash: true, bashForegroundMs: 1500 },
      tools: {
        exec: {
          host: "gateway",
          security: "allowlist",
          ask: "on-miss",
          node: "global-node",
          pathPrepend: ["/global/bin"],
          safeBins: ["wc"],
          safeBinTrustedDirs: ["/global/trusted"],
          safeBinProfiles: {
            wc: { maxPositional: 0 },
          },
          strictInlineEval: false,
          timeoutSec: 12,
          approvalRunningNoticeMs: 345,
          notifyOnExit: false,
          notifyOnExitEmptySuccess: true,
        },
      },
      agents: {
        list: [
          {
            id: "ops",
            tools: {
              exec: {
                security: "full",
                safeBins: ["grep"],
                safeBinProfiles: {
                  grep: { maxPositional: 1 },
                },
                strictInlineEval: true,
                timeoutSec: 34,
                notifyOnExit: true,
              },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      execHost: "node",
      execSecurity: "deny",
      execAsk: "always",
      execNode: "session-node",
    } satisfies SessionEntry;

    const result = await handleBashChatCommand(
      buildRunParams({ cfg, agentId: "ops", sessionEntry }),
    );

    expect(result.text).toContain("Exit: 0");
    expect(createExecToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: "chat:bash",
        allowBackground: true,
        sessionKey: "agent:ops:whatsapp:direct:user-1",
        host: "node",
        security: "deny",
        ask: "always",
        node: "session-node",
        pathPrepend: ["/global/bin"],
        safeBins: ["grep"],
        safeBinTrustedDirs: ["/global/trusted"],
        safeBinProfiles: {
          wc: { maxPositional: 0 },
          grep: { maxPositional: 1 },
        },
        strictInlineEval: true,
        timeoutSec: 34,
        approvalRunningNoticeMs: 345,
        notifyOnExit: true,
        notifyOnExitEmptySuccess: true,
        elevated: {
          enabled: true,
          allowed: true,
          defaultLevel: "on",
        },
      }),
    );
    expect(execExecuteMock).toHaveBeenCalledWith("chat-bash", {
      command: "echo ok",
      background: false,
      yieldMs: 1500,
      timeout: 34,
      elevated: true,
    });
  });
});
