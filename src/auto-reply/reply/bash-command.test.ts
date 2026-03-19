import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";

const createExecToolMock = vi.hoisted(() => vi.fn());
const execToolExecuteMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/bash-tools.js", () => ({
  createExecTool: createExecToolMock,
}));

const { handleBashChatCommand, resetBashChatCommandForTests } = await import("./bash-command.js");

describe("handleBashChatCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBashChatCommandForTests();
    createExecToolMock.mockReturnValue({
      execute: execToolExecuteMock.mockResolvedValue({
        content: [{ type: "text", text: "host ok" }],
        details: {
          status: "completed",
          exitCode: 0,
          durationMs: 1,
          aggregated: "host ok",
        },
      }),
    });
  });

  it("inherits configured exec policy for /bash sessions", async () => {
    const cfg = {
      commands: { bash: true, text: true },
      tools: {
        exec: {
          security: "full",
          ask: "off",
          pathPrepend: ["/opt/host/bin"],
          safeBins: ["journalctl"],
          safeBinTrustedDirs: ["/usr/bin"],
          safeBinProfiles: {
            journalctl: {
              argvPolicy: "exact",
            },
          },
          timeoutSec: 90,
          notifyOnExit: true,
          notifyOnExitEmptySuccess: false,
        },
      },
    } as OpenClawConfig;
    const ctx = {
      Body: "/bash journalctl -n 5",
      CommandBody: "/bash journalctl -n 5",
      Provider: "feishu",
      Surface: "feishu",
      SessionKey: "agent:shoudeng:main",
    } as MsgContext;

    const result = await handleBashChatCommand({
      ctx,
      cfg,
      agentId: "shoudeng",
      sessionKey: "agent:shoudeng:main",
      isGroup: false,
      elevated: {
        enabled: true,
        allowed: true,
        failures: [],
      },
    });

    expect(createExecToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: "chat:bash",
        allowBackground: true,
        security: "full",
        ask: "off",
        pathPrepend: ["/opt/host/bin"],
        safeBins: ["journalctl"],
        safeBinTrustedDirs: ["/usr/bin"],
        safeBinProfiles: {
          journalctl: {
            argvPolicy: "exact",
          },
        },
        timeoutSec: 90,
        sessionKey: "agent:shoudeng:main",
        notifyOnExit: true,
        notifyOnExitEmptySuccess: false,
        elevated: {
          enabled: true,
          allowed: true,
          defaultLevel: "on",
        },
      }),
    );
    expect(execToolExecuteMock).toHaveBeenCalledWith(
      "chat-bash",
      expect.objectContaining({
        command: "journalctl -n 5",
        elevated: true,
      }),
    );
    expect(result.text).toContain("host ok");
  });
});
