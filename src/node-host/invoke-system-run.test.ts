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
  function createLocalRunResult(stdout = "local-ok") {
    return {
      success: true,
      stdout,
      stderr: "",
      timedOut: false,
      truncated: false,
      exitCode: 0,
      error: null,
    };
  }

  function expectInvokeOk(
    sendInvokeResult: ReturnType<typeof vi.fn>,
    params?: { payloadContains?: string },
  ) {
    expect(sendInvokeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        ...(params?.payloadContains
          ? { payloadJSON: expect.stringContaining(params.payloadContains) }
          : {}),
      }),
    );
  }

  function expectInvokeErrorMessage(
    sendInvokeResult: ReturnType<typeof vi.fn>,
    params: { message: string; exact?: boolean },
  ) {
    expect(sendInvokeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          message: params.exact ? params.message : expect.stringContaining(params.message),
        }),
      }),
    );
  }

  function expectApprovalRequiredDenied(params: {
    sendNodeEvent: ReturnType<typeof vi.fn>;
    sendInvokeResult: ReturnType<typeof vi.fn>;
  }) {
    expect(params.sendNodeEvent).toHaveBeenCalledWith(
      expect.anything(),
      "exec.denied",
      expect.objectContaining({ reason: "approval-required" }),
    );
    expectInvokeErrorMessage(params.sendInvokeResult, {
      message: "SYSTEM_RUN_DENIED: approval required",
      exact: true,
    });
  }

  function buildNestedEnvShellCommand(params: { depth: number; payload: string }): string[] {
    return [...Array(params.depth).fill("/usr/bin/env"), "/bin/sh", "-c", params.payload];
  }

  async function withTempApprovalsHome<T>(params: {
    approvals: Parameters<typeof saveExecApprovals>[0];
    run: (ctx: { tempHome: string }) => Promise<T>;
  }): Promise<T> {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-approvals-"));
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = tempHome;
    saveExecApprovals(params.approvals);
    try {
      return await params.run({ tempHome });
    } finally {
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }

  async function withPathTokenCommand<T>(params: {
    tmpPrefix: string;
    run: (ctx: { link: string; expected: string }) => Promise<T>;
  }): Promise<T> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), params.tmpPrefix));
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, "poccmd");
    fs.symlinkSync("/bin/echo", link);
    const expected = fs.realpathSync(link);
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    try {
      return await params.run({ link, expected });
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  function expectCommandPinnedToCanonicalPath(params: {
    runCommand: ReturnType<typeof vi.fn>;
    expected: string;
    commandTail: string[];
    cwd?: string;
  }) {
    expect(params.runCommand).toHaveBeenCalledWith(
      [params.expected, ...params.commandTail],
      params.cwd,
      undefined,
      undefined,
    );
  }

  async function runSystemInvoke(params: {
    preferMacAppExecHost: boolean;
    runViaResponse?: ExecHostResponse | null;
    command?: string[];
    cwd?: string;
    security?: "full" | "allowlist";
    ask?: "off" | "on-miss" | "always";
    approved?: boolean;
    runCommand?: ReturnType<typeof vi.fn>;
    runViaMacAppExecHost?: ReturnType<typeof vi.fn>;
    sendInvokeResult?: ReturnType<typeof vi.fn>;
    sendExecFinishedEvent?: ReturnType<typeof vi.fn>;
    sendNodeEvent?: ReturnType<typeof vi.fn>;
    skillBinsCurrent?: () => Promise<Array<{ name: string; resolvedPath: string }>>;
  }) {
    const runCommand =
      params.runCommand ??
      vi.fn(async (_command: string[], _cwd?: string, _env?: Record<string, string>) =>
        createLocalRunResult(),
      );
    const runViaMacAppExecHost =
      params.runViaMacAppExecHost ?? vi.fn(async () => params.runViaResponse ?? null);
    const sendInvokeResult = params.sendInvokeResult ?? vi.fn(async () => {});
    const sendExecFinishedEvent = params.sendExecFinishedEvent ?? vi.fn(async () => {});
    const sendNodeEvent = params.sendNodeEvent ?? vi.fn(async () => {});

    await handleSystemRunInvoke({
      client: {} as never,
      params: {
        command: params.command ?? ["echo", "ok"],
        cwd: params.cwd,
        approved: params.approved ?? false,
        sessionKey: "agent:main:main",
      },
      skillBins: {
        current: params.skillBinsCurrent ?? (async () => []),
      },
      execHostEnforced: false,
      execHostFallbackAllowed: true,
      resolveExecSecurity: () => params.security ?? "full",
      resolveExecAsk: () => params.ask ?? "off",
      isCmdExeInvocation: () => false,
      sanitizeEnv: () => undefined,
      runCommand,
      runViaMacAppExecHost,
      sendNodeEvent,
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
    expectInvokeOk(sendInvokeResult, { payloadContains: "local-ok" });
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
    expectInvokeOk(sendInvokeResult, { payloadContains: "app-ok" });
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
      expectInvokeErrorMessage(sendInvokeResult, { message: "allowlist miss" });
      return;
    }

    const runArgs = vi.mocked(runCommand).mock.calls[0]?.[0] as string[] | undefined;
    expect(runArgs).toBeDefined();
    expect(runArgs?.[0]).toMatch(/(^|[/\\])tr$/);
    expect(runArgs?.slice(1)).toEqual(["a", "b"]);
    expectInvokeOk(sendInvokeResult);
  });

  it("denies semantic env wrappers in allowlist mode", async () => {
    const { runCommand, sendInvokeResult } = await runSystemInvoke({
      preferMacAppExecHost: false,
      security: "allowlist",
      command: ["env", "FOO=bar", "tr", "a", "b"],
    });
    expect(runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(sendInvokeResult, { message: "allowlist miss" });
  });

  it.runIf(process.platform !== "win32")(
    "pins PATH-token executable to canonical path for approval-based runs",
    async () => {
      await withPathTokenCommand({
        tmpPrefix: "openclaw-approval-path-pin-",
        run: async ({ expected }) => {
          const { runCommand, sendInvokeResult } = await runSystemInvoke({
            preferMacAppExecHost: false,
            command: ["poccmd", "-n", "SAFE"],
            approved: true,
            security: "full",
            ask: "off",
          });
          expectCommandPinnedToCanonicalPath({
            runCommand,
            expected,
            commandTail: ["-n", "SAFE"],
          });
          expectInvokeOk(sendInvokeResult);
        },
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "pins PATH-token executable to canonical path for allowlist runs",
    async () => {
      const runCommand = vi.fn(async () => ({
        ...createLocalRunResult(),
      }));
      const sendInvokeResult = vi.fn(async () => {});
      await withPathTokenCommand({
        tmpPrefix: "openclaw-allowlist-path-pin-",
        run: async ({ link, expected }) => {
          await withTempApprovalsHome({
            approvals: {
              version: 1,
              defaults: {
                security: "allowlist",
                ask: "off",
                askFallback: "deny",
              },
              agents: {
                main: {
                  allowlist: [{ pattern: link }],
                },
              },
            },
            run: async () => {
              await runSystemInvoke({
                preferMacAppExecHost: false,
                command: ["poccmd", "-n", "SAFE"],
                security: "allowlist",
                ask: "off",
                runCommand,
                sendInvokeResult,
              });
            },
          });
          expectCommandPinnedToCanonicalPath({
            runCommand,
            expected,
            commandTail: ["-n", "SAFE"],
          });
          expectInvokeOk(sendInvokeResult);
        },
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "denies approval-based execution when cwd is a symlink",
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-cwd-link-"));
      const safeDir = path.join(tmp, "safe");
      const linkDir = path.join(tmp, "cwd-link");
      const script = path.join(safeDir, "run.sh");
      fs.mkdirSync(safeDir, { recursive: true });
      fs.writeFileSync(script, "#!/bin/sh\necho SAFE\n");
      fs.chmodSync(script, 0o755);
      fs.symlinkSync(safeDir, linkDir, "dir");
      try {
        const { runCommand, sendInvokeResult } = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: ["./run.sh"],
          cwd: linkDir,
          approved: true,
          security: "full",
          ask: "off",
        });
        expect(runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(sendInvokeResult, { message: "canonical cwd" });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "denies approval-based execution when cwd contains a symlink parent component",
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-cwd-parent-link-"));
      const safeRoot = path.join(tmp, "safe-root");
      const safeSub = path.join(safeRoot, "sub");
      const linkRoot = path.join(tmp, "approved-link");
      fs.mkdirSync(safeSub, { recursive: true });
      fs.symlinkSync(safeRoot, linkRoot, "dir");
      try {
        const { runCommand, sendInvokeResult } = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: ["./run.sh"],
          cwd: path.join(linkRoot, "sub"),
          approved: true,
          security: "full",
          ask: "off",
        });
        expect(runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(sendInvokeResult, { message: "no symlink path components" });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it("uses canonical executable path for approval-based relative command execution", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-cwd-real-"));
    const script = path.join(tmp, "run.sh");
    fs.writeFileSync(script, "#!/bin/sh\necho SAFE\n");
    fs.chmodSync(script, 0o755);
    try {
      const { runCommand, sendInvokeResult } = await runSystemInvoke({
        preferMacAppExecHost: false,
        command: ["./run.sh", "--flag"],
        cwd: tmp,
        approved: true,
        security: "full",
        ask: "off",
      });
      expectCommandPinnedToCanonicalPath({
        runCommand,
        expected: fs.realpathSync(script),
        commandTail: ["--flag"],
        cwd: fs.realpathSync(tmp),
      });
      expectInvokeOk(sendInvokeResult);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("denies ./sh wrapper spoof in allowlist on-miss mode before execution", async () => {
    const marker = path.join(os.tmpdir(), `openclaw-wrapper-spoof-${process.pid}-${Date.now()}`);
    const runCommand = vi.fn(async () => {
      fs.writeFileSync(marker, "executed");
      return createLocalRunResult();
    });
    const sendInvokeResult = vi.fn(async () => {});
    const sendNodeEvent = vi.fn(async () => {});

    await runSystemInvoke({
      preferMacAppExecHost: false,
      command: ["./sh", "-lc", "/bin/echo approved-only"],
      security: "allowlist",
      ask: "on-miss",
      runCommand,
      sendInvokeResult,
      sendNodeEvent,
    });

    expect(runCommand).not.toHaveBeenCalled();
    expect(fs.existsSync(marker)).toBe(false);
    expectApprovalRequiredDenied({ sendNodeEvent, sendInvokeResult });
    try {
      fs.unlinkSync(marker);
    } catch {
      // no-op
    }
  });

  it("denies ./skill-bin even when autoAllowSkills trust entry exists", async () => {
    const runCommand = vi.fn(async () => createLocalRunResult());
    const sendInvokeResult = vi.fn(async () => {});
    const sendNodeEvent = vi.fn(async () => {});

    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: {
          security: "allowlist",
          ask: "on-miss",
          askFallback: "deny",
          autoAllowSkills: true,
        },
        agents: {},
      },
      run: async ({ tempHome }) => {
        const skillBinPath = path.join(tempHome, "skill-bin");
        fs.writeFileSync(skillBinPath, "#!/bin/sh\necho should-not-run\n", { mode: 0o755 });
        fs.chmodSync(skillBinPath, 0o755);
        await runSystemInvoke({
          preferMacAppExecHost: false,
          command: ["./skill-bin", "--help"],
          cwd: tempHome,
          security: "allowlist",
          ask: "on-miss",
          skillBinsCurrent: async () => [{ name: "skill-bin", resolvedPath: skillBinPath }],
          runCommand,
          sendInvokeResult,
          sendNodeEvent,
        });
      },
    });

    expect(runCommand).not.toHaveBeenCalled();
    expectApprovalRequiredDenied({ sendNodeEvent, sendInvokeResult });
  });

  it("denies env -S shell payloads in allowlist mode", async () => {
    const { runCommand, sendInvokeResult } = await runSystemInvoke({
      preferMacAppExecHost: false,
      security: "allowlist",
      command: ["env", "-S", 'sh -c "echo pwned"'],
    });
    expect(runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(sendInvokeResult, { message: "allowlist miss" });
  });

  it("denies semicolon-chained shell payloads in allowlist mode without explicit approval", async () => {
    const payloads = ["openclaw status; id", "openclaw status; cat /etc/passwd"];
    for (const payload of payloads) {
      const command =
        process.platform === "win32"
          ? ["cmd.exe", "/d", "/s", "/c", payload]
          : ["/bin/sh", "-lc", payload];
      const { runCommand, sendInvokeResult } = await runSystemInvoke({
        preferMacAppExecHost: false,
        security: "allowlist",
        ask: "on-miss",
        command,
      });
      expect(runCommand, payload).not.toHaveBeenCalled();
      expectInvokeErrorMessage(sendInvokeResult, {
        message: "SYSTEM_RUN_DENIED: approval required",
        exact: true,
      });
    }
  });

  it("denies nested env shell payloads when wrapper depth is exceeded", async () => {
    if (process.platform === "win32") {
      return;
    }
    const runCommand = vi.fn(async () => {
      throw new Error("runCommand should not be called for nested env depth overflow");
    });
    const sendInvokeResult = vi.fn(async () => {});
    const sendNodeEvent = vi.fn(async () => {});

    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: {
          security: "allowlist",
          ask: "on-miss",
          askFallback: "deny",
        },
        agents: {
          main: {
            allowlist: [{ pattern: "/usr/bin/env" }],
          },
        },
      },
      run: async ({ tempHome }) => {
        const marker = path.join(tempHome, "pwned.txt");
        await runSystemInvoke({
          preferMacAppExecHost: false,
          command: buildNestedEnvShellCommand({
            depth: 5,
            payload: `echo PWNED > ${marker}`,
          }),
          security: "allowlist",
          ask: "on-miss",
          runCommand,
          sendInvokeResult,
          sendNodeEvent,
        });
        expect(fs.existsSync(marker)).toBe(false);
      },
    });

    expect(runCommand).not.toHaveBeenCalled();
    expectApprovalRequiredDenied({ sendNodeEvent, sendInvokeResult });
  });
});
