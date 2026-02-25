import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { saveExecApprovals } from "../infra/exec-approvals.js";
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
    command?: string[];
    security?: "full" | "allowlist";
    ask?: "off" | "on-miss" | "always";
    approved?: boolean;
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
        command: params.command ?? ["echo", "ok"],
        approved: params.approved ?? false,
        sessionKey: "agent:main:main",
      },
      skillBins: {
        current: async () => [],
      },
      execHostEnforced: false,
      execHostFallbackAllowed: true,
      resolveExecSecurity: () => params.security ?? "full",
      resolveExecAsk: () => params.ask ?? "off",
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

  it("forwards canonical cmdText to mac app exec host for positional-argv shell wrappers", async () => {
    const { runViaMacAppExecHost } = await runSystemInvoke({
      preferMacAppExecHost: true,
      command: ["/bin/sh", "-lc", '$0 "$1"', "/usr/bin/touch", "/tmp/marker"],
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
      approvals: expect.anything(),
      request: expect.objectContaining({
        command: ["/bin/sh", "-lc", '$0 "$1"', "/usr/bin/touch", "/tmp/marker"],
        rawCommand: '/bin/sh -lc "$0 \\"$1\\"" /usr/bin/touch /tmp/marker',
      }),
    });
  });

  it("handles transparent env wrappers in allowlist mode", async () => {
    const { runCommand, sendInvokeResult } = await runSystemInvoke({
      preferMacAppExecHost: false,
      security: "allowlist",
      command: ["env", "tr", "a", "b"],
    });
    if (process.platform === "win32") {
      expect(runCommand).not.toHaveBeenCalled();
      expect(sendInvokeResult).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({
            message: expect.stringContaining("allowlist miss"),
          }),
        }),
      );
      return;
    }

    expect(runCommand).toHaveBeenCalledWith(["tr", "a", "b"], undefined, undefined, undefined);
    expect(sendInvokeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
      }),
    );
  });

  it("denies semantic env wrappers in allowlist mode", async () => {
    const { runCommand, sendInvokeResult } = await runSystemInvoke({
      preferMacAppExecHost: false,
      security: "allowlist",
      command: ["env", "FOO=bar", "tr", "a", "b"],
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(sendInvokeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          message: expect.stringContaining("allowlist miss"),
        }),
      }),
    );
  });
  it("denies ./sh wrapper spoof in allowlist on-miss mode before execution", async () => {
    const marker = path.join(os.tmpdir(), `openclaw-wrapper-spoof-${process.pid}-${Date.now()}`);
    const runCommand = vi.fn(async () => {
      fs.writeFileSync(marker, "executed");
      return {
        success: true,
        stdout: "local-ok",
        stderr: "",
        timedOut: false,
        truncated: false,
        exitCode: 0,
        error: null,
      };
    });
    const sendInvokeResult = vi.fn(async () => {});
    const sendNodeEvent = vi.fn(async () => {});

    await handleSystemRunInvoke({
      client: {} as never,
      params: {
        command: ["./sh", "-lc", "/bin/echo approved-only"],
        sessionKey: "agent:main:main",
      },
      skillBins: {
        current: async () => [],
      },
      execHostEnforced: false,
      execHostFallbackAllowed: true,
      resolveExecSecurity: () => "allowlist",
      resolveExecAsk: () => "on-miss",
      isCmdExeInvocation: () => false,
      sanitizeEnv: () => undefined,
      runCommand,
      runViaMacAppExecHost: vi.fn(async () => null),
      sendNodeEvent,
      buildExecEventPayload: (payload) => payload,
      sendInvokeResult,
      sendExecFinishedEvent: vi.fn(async () => {}),
      preferMacAppExecHost: false,
    });

    expect(runCommand).not.toHaveBeenCalled();
    expect(fs.existsSync(marker)).toBe(false);
    expect(sendNodeEvent).toHaveBeenCalledWith(
      expect.anything(),
      "exec.denied",
      expect.objectContaining({ reason: "approval-required" }),
    );
    expect(sendInvokeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          message: "SYSTEM_RUN_DENIED: approval required",
        }),
      }),
    );
    try {
      fs.unlinkSync(marker);
    } catch {
      // no-op
    }
  });

  it("denies ./skill-bin even when autoAllowSkills trust entry exists", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-skill-path-spoof-"));
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const skillBinPath = path.join(tempHome, "skill-bin");
    fs.writeFileSync(skillBinPath, "#!/bin/sh\necho should-not-run\n", { mode: 0o755 });
    fs.chmodSync(skillBinPath, 0o755);
    process.env.OPENCLAW_HOME = tempHome;
    saveExecApprovals({
      version: 1,
      defaults: {
        security: "allowlist",
        ask: "on-miss",
        askFallback: "deny",
        autoAllowSkills: true,
      },
      agents: {},
    });
    const runCommand = vi.fn(async () => ({
      success: true,
      stdout: "local-ok",
      stderr: "",
      timedOut: false,
      truncated: false,
      exitCode: 0,
      error: null,
    }));
    const sendInvokeResult = vi.fn(async () => {});
    const sendNodeEvent = vi.fn(async () => {});

    try {
      await handleSystemRunInvoke({
        client: {} as never,
        params: {
          command: ["./skill-bin", "--help"],
          cwd: tempHome,
          sessionKey: "agent:main:main",
        },
        skillBins: {
          current: async () => [{ name: "skill-bin", resolvedPath: skillBinPath }],
        },
        execHostEnforced: false,
        execHostFallbackAllowed: true,
        resolveExecSecurity: () => "allowlist",
        resolveExecAsk: () => "on-miss",
        isCmdExeInvocation: () => false,
        sanitizeEnv: () => undefined,
        runCommand,
        runViaMacAppExecHost: vi.fn(async () => null),
        sendNodeEvent,
        buildExecEventPayload: (payload) => payload,
        sendInvokeResult,
        sendExecFinishedEvent: vi.fn(async () => {}),
        preferMacAppExecHost: false,
      });
    } finally {
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
    }

    expect(runCommand).not.toHaveBeenCalled();
    expect(sendNodeEvent).toHaveBeenCalledWith(
      expect.anything(),
      "exec.denied",
      expect.objectContaining({ reason: "approval-required" }),
    );
    expect(sendInvokeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          message: "SYSTEM_RUN_DENIED: approval required",
        }),
      }),
    );
  });

  it("denies env -S shell payloads in allowlist mode", async () => {
    const { runCommand, sendInvokeResult } = await runSystemInvoke({
      preferMacAppExecHost: false,
      security: "allowlist",
      command: ["env", "-S", 'sh -c "echo pwned"'],
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(sendInvokeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          message: expect.stringContaining("allowlist miss"),
        }),
      }),
    );
  });
});
