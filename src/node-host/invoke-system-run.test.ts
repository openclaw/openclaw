import { describe, expect, it, vi } from "vitest";
import type { ExecHostResponse } from "../infra/exec-host.js";
import { handleSystemRunInvoke, formatSystemRunAllowlistMissMessage } from "./invoke-system-run.js";

describe("formatSystemRunAllowlistMissMessage", () => {
  it("returns legacy allowlist miss message by default", () => {
    expect(formatSystemRunAllowlistMissMessage()).toBe("SYSTEM_RUN_DENIED: allowlist miss");
  });

  it("adds Windows shell-wrapper guidance when blocked by cmd.exe policy", () => {
    expect(
      formatSystemRunAllowlistMissMessage({
        windowsShellWrapperBlocked: true,
      }),
    ).toContain("Windows shell wrappers like cmd.exe /c require approval");
  });
});

describe("handleSystemRunInvoke mac app exec host routing", () => {
  async function runSystemInvoke(params: {
    preferMacAppExecHost: boolean;
    runViaResponse?: ExecHostResponse | null;
  }) {
    const runCommand = vi.fn(async () => ({
      success: true,
      stdout: "local-ok",
      stderr: "",
      timedOut: false,
      truncated: false,
      exitCode: 0,
      error: null,
    }));
    const runViaMacAppExecHost = vi.fn(async () => params.runViaResponse ?? null);
    const sendInvokeResult = vi.fn(async () => {});
    const sendExecFinishedEvent = vi.fn(async () => {});

    await handleSystemRunInvoke({
      client: {} as never,
      params: {
        command: ["echo", "ok"],
        approved: true,
        sessionKey: "agent:main:main",
      },
      skillBins: {
        current: async () => new Set<string>(),
      },
      execHostEnforced: false,
      execHostFallbackAllowed: true,
      resolveExecSecurity: () => "full",
      resolveExecAsk: () => "off",
      isCmdExeInvocation: () => false,
      sanitizeEnv: () => undefined,
      runCommand,
      runViaMacAppExecHost,
      sendNodeEvent: async () => {},
      buildExecEventPayload: (payload) => payload,
      sendInvokeResult,
      sendExecFinishedEvent,
      preferMacAppExecHost: params.preferMacAppExecHost,
    });

    return { runCommand, runViaMacAppExecHost, sendInvokeResult, sendExecFinishedEvent };
  }

  it("uses local execution by default when mac app exec host preference is disabled", async () => {
    const { runCommand, runViaMacAppExecHost, sendInvokeResult } = await runSystemInvoke({
      preferMacAppExecHost: false,
    });

    expect(runViaMacAppExecHost).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(sendInvokeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        payloadJSON: expect.stringContaining("local-ok"),
      }),
    );
  });

  it("uses mac app exec host when explicitly preferred", async () => {
    const { runCommand, runViaMacAppExecHost, sendInvokeResult } = await runSystemInvoke({
      preferMacAppExecHost: true,
      runViaResponse: {
        ok: true,
        payload: {
          success: true,
          stdout: "app-ok",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          error: null,
        },
      },
    });

    expect(runViaMacAppExecHost).toHaveBeenCalledWith({
      approvals: expect.objectContaining({
        agent: expect.objectContaining({
          security: "full",
          ask: "off",
        }),
      }),
      request: expect.objectContaining({
        command: ["echo", "ok"],
      }),
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(sendInvokeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        payloadJSON: expect.stringContaining("app-ok"),
      }),
    );
  });
});
