import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRECHECK_NO_WORK_REASON,
  PRECHECK_SKIPPED_ERROR_REASON,
  PRECHECK_POLICY_DENIED_REASON,
  authorizeCronJobPrecheckCommand,
  cronRunOutcomeFromPrecheck,
  cronToolsAllowPermitsPrecheckExec,
  interpretPrecheckOutput,
  normalizeCronJobPrecheck,
  resolveTrustedPrecheckShellCommand,
  runCronJobPrecheck,
} from "./job-precheck.js";

describe("interpretPrecheckOutput", () => {
  it("treats exit 0 as work and exit 2 as no-work by default", () => {
    expect(interpretPrecheckOutput({ exitCode: 0, stdout: "", stderr: "" }).decision).toBe("run");
    const skip = interpretPrecheckOutput({ exitCode: 2, stdout: "", stderr: "" });
    expect(skip.decision).toBe("skip");
    if (skip.decision === "skip") {
      expect(skip.reason).toBe(PRECHECK_NO_WORK_REASON);
    }
  });

  it("honors WORK_NEEDED / NO_WORK prefixes over exit code", () => {
    expect(
      interpretPrecheckOutput({
        exitCode: 2,
        stdout: "WORK_NEEDED: dirty prs\n",
        stderr: "",
      }).decision,
    ).toBe("run");
    expect(
      interpretPrecheckOutput({
        exitCode: 0,
        stdout: "NO_WORK\n",
        stderr: "",
      }).decision,
    ).toBe("skip");
  });

  it("does not treat empty noWorkStdoutPrefix as universal skip", () => {
    // ClawSweeper P1: startsWith("") is always true — empty prefixes must not match.
    const result = interpretPrecheckOutput({
      exitCode: 0,
      stdout: "anything",
      stderr: "",
      workStdoutPrefix: "",
      noWorkStdoutPrefix: "",
      contract: "exit-code",
    });
    expect(result.decision).toBe("run");
  });

  it("maps unexpected exits to error (or skip when onError=skip)", () => {
    expect(interpretPrecheckOutput({ exitCode: 7, stdout: "", stderr: "boom" }).decision).toBe(
      "error",
    );
    const skippedError = interpretPrecheckOutput({
      exitCode: 7,
      stdout: "",
      stderr: "boom",
      onError: "skip",
    });
    expect(skippedError.decision).toBe("skip");
    if (skippedError.decision === "skip") {
      expect(skippedError.reason).toBe(PRECHECK_SKIPPED_ERROR_REASON);
      expect(skippedError.reason).not.toBe(PRECHECK_NO_WORK_REASON);
    }
  });
});

describe("cronRunOutcomeFromPrecheck", () => {
  it("emits skipped outcome with stable reason for no-work", () => {
    const outcome = cronRunOutcomeFromPrecheck({
      decision: "skip",
      reason: PRECHECK_NO_WORK_REASON,
      exitCode: 2,
      stdout: "NO_WORK",
      stderr: "",
    });
    expect(outcome.status).toBe("skipped");
    expect(outcome.error).toBe(PRECHECK_NO_WORK_REASON);
    expect(outcome.diagnostics?.summary).toBe(PRECHECK_NO_WORK_REASON);
  });

  it("preserves skipped-error reason distinct from no-work (onError=skip)", () => {
    const outcome = cronRunOutcomeFromPrecheck({
      decision: "skip",
      reason: PRECHECK_SKIPPED_ERROR_REASON,
      exitCode: 7,
      stdout: "",
      stderr: "boom",
    });
    expect(outcome.status).toBe("skipped");
    expect(outcome.error).toBe(PRECHECK_SKIPPED_ERROR_REASON);
    expect(outcome.diagnostics?.summary).toBe(PRECHECK_SKIPPED_ERROR_REASON);
    expect(outcome.error).not.toBe(PRECHECK_NO_WORK_REASON);
  });
});

describe("normalizeCronJobPrecheck", () => {
  it("rejects overlapping work and no-work exit codes", () => {
    expect(() =>
      normalizeCronJobPrecheck({
        command: "echo hi",
        workExitCodes: [0, 2],
        noWorkExitCodes: [2, 3],
      }),
    ).toThrow(/must not overlap/);
  });

  it("requires a command and normalizes kinds", () => {
    expect(normalizeCronJobPrecheck(null)).toBeUndefined();
    expect(normalizeCronJobPrecheck({})).toBeUndefined();
    expect(normalizeCronJobPrecheck({ command: " exit 2 " })).toEqual({
      kind: "exec",
      command: "exit 2",
    });
  });

  it("rejects present-but-invalid timeoutMs instead of coercing defaults", () => {
    expect(() => normalizeCronJobPrecheck({ command: "echo hi", timeoutMs: 0 })).toThrow(
      /timeoutMs must be a positive finite number/,
    );
    expect(() => normalizeCronJobPrecheck({ command: "echo hi", timeoutMs: -5 })).toThrow(
      /timeoutMs must be a positive finite number/,
    );
    expect(() =>
      normalizeCronJobPrecheck({ command: "echo hi", timeoutMs: "fast" as unknown as number }),
    ).toThrow(/timeoutMs must be a positive finite number/);
  });

  it("rejects malformed exit-code lists instead of dropping bad entries", () => {
    expect(() =>
      normalizeCronJobPrecheck({
        command: "echo hi",
        workExitCodes: [0, "x" as unknown as number],
      }),
    ).toThrow(/workExitCodes must contain only finite numbers/);
    expect(() => normalizeCronJobPrecheck({ command: "echo hi", noWorkExitCodes: [] })).toThrow(
      /noWorkExitCodes must be a non-empty array/,
    );
  });
});

const AUTH_FULL = {
  triggersEnabled: true,
  security: "full" as const,
  securityOverrideOnly: true,
  toolsAllow: ["*"] as const,
};

describe("authorizeCronJobPrecheckCommand", () => {
  it("denies when triggers are disabled", async () => {
    const result = await authorizeCronJobPrecheckCommand({
      command: "exit 0",
      authz: {
        triggersEnabled: false,
        security: "full",
        securityOverrideOnly: true,
        toolsAllow: ["*"],
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/cron\.triggers\.enabled/);
    }
  });

  it("denies when exec security is deny", async () => {
    const result = await authorizeCronJobPrecheckCommand({
      command: "exit 0",
      authz: {
        triggersEnabled: true,
        security: "deny",
        securityOverrideOnly: true,
        toolsAllow: ["*"],
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain(PRECHECK_POLICY_DENIED_REASON);
      expect(result.reason).toMatch(/security=deny/i);
    }
  });

  it("allows when triggers enabled and security=full", async () => {
    const result = await authorizeCronJobPrecheckCommand({
      command: "exit 0",
      authz: AUTH_FULL,
    });
    expect(result).toEqual({ allowed: true });
  });

  it("denies when tools.exec.security=deny even if approvals would default full", async () => {
    // Regression for ClawSweeper P1: config tools.exec must be layered before
    // resolveExecApprovalsLocked (which defaults security=full when no file).
    const result = await authorizeCronJobPrecheckCommand({
      command: "exit 0",
      authz: {
        triggersEnabled: true,
        // No securityOverrideOnly — exercise live approvals path with config layer.
        toolsAllow: ["*"],
        toolsExec: { security: "deny" },
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain(PRECHECK_POLICY_DENIED_REASON);
      expect(result.reason).toMatch(/security=deny/i);
    }
  });

  it("denies when agent tools.exec.security=deny tightens global full", async () => {
    const result = await authorizeCronJobPrecheckCommand({
      command: "exit 0",
      authz: {
        triggersEnabled: true,
        toolsAllow: ["*"],
        toolsExec: { security: "full" },
        agentToolsExec: { security: "deny" },
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/security=deny/i);
    }
  });

  it("passes tools.exec layers into resolveExecSafeBinRuntimePolicy (source contract)", () => {
    // ClawSweeper P1: empty {} dropped global/agent safeBins. Keep the call site wired.
    const src = fs.readFileSync(new URL("./job-precheck-authz.ts", import.meta.url), "utf8");
    expect(src).toContain("global: params.authz.toolsExec");
    expect(src).toContain("local: params.authz.agentToolsExec");
    expect(src).not.toMatch(/resolveExecSafeBinRuntimePolicy\(\{\s*\}\)/);
  });

  it("defaults unconfigured exec policy to allowlist (not full)", async () => {
    // ClawSweeper P1: canonical system.run default is allowlist when tools.exec
    // security is omitted. An empty allowlist must deny arbitrary commands.
    const result = await authorizeCronJobPrecheckCommand({
      command: "echo should-not-run-unconfigured",
      authz: {
        triggersEnabled: true,
        toolsAllow: ["*"],
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain(PRECHECK_POLICY_DENIED_REASON);
    }
  });
  it("denies when tools.exec.ask is always (unattended cannot prompt)", async () => {
    const result = await authorizeCronJobPrecheckCommand({
      command: "echo WORK_NEEDED",
      authz: {
        triggersEnabled: true,
        security: "full",
        securityOverrideOnly: false,
        toolsAllow: ["*"],
        toolsExec: { ask: "always", security: "full" },
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/ask=always|requires approval/);
    }
  });

  it("denies when agent tools.exec.ask is always", async () => {
    const result = await authorizeCronJobPrecheckCommand({
      command: "echo WORK_NEEDED",
      authz: {
        triggersEnabled: true,
        security: "full",
        toolsAllow: ["*"],
        toolsExec: { ask: "off", security: "full" },
        agentToolsExec: { ask: "always" },
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/ask=always|requires approval/);
    }
  });

  it("denies inline-eval carriers when tools.exec.strictInlineEval is true", async () => {
    // ClawSweeper P1: unattended precheck must fail closed on strictInlineEval
    // (no prompt path), matching system.run.
    const result = await authorizeCronJobPrecheckCommand({
      command: "python3 -c 'print(1)'",
      authz: {
        triggersEnabled: true,
        security: "full",
        securityOverrideOnly: true,
        toolsAllow: ["*"],
        toolsExec: { strictInlineEval: true, security: "full" },
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/strictInlineEval/i);
    }
  });
});

describe("runCronJobPrecheck", () => {
  it("blocks host spawn when policy denies (security=deny)", async () => {
    const result = await runCronJobPrecheck(
      { command: "exit 0" },
      {
        authz: {
          triggersEnabled: true,
          security: "deny",
          securityOverrideOnly: true,
          toolsAllow: ["*"],
        },
      },
    );
    expect(result.decision).toBe("error");
    if (result.decision === "error") {
      expect(result.reason).toContain(PRECHECK_POLICY_DENIED_REASON);
    }
  });

  it("blocks host spawn when tools.exec.host is sandbox/node (no gateway bypass)", async () => {
    let spawned!: boolean;
    const spawnImpl = ((..._args: unknown[]) => {
      spawned = true;
      throw new Error("should not spawn");
    }) as unknown as typeof import("node:child_process").spawn;
    const toolsAllow = ["exec"] as const;

    for (const host of ["sandbox", "node", "auto"] as const) {
      spawned = false;
      const result = await runCronJobPrecheck(
        { command: "echo WORK_NEEDED" },
        {
          spawnImpl,
          authz: {
            triggersEnabled: true,
            toolsAllow,
            toolsExec: { host, security: "full" },
          },
        },
      );
      expect(result.decision).toBe("error");
      if (result.decision === "error") {
        expect(result.reason).toMatch(/host=/);
        expect(result.reason).toMatch(/not supported for cron precheck|sandbox\/node bypass/);
      }
      expect(spawned).toBe(false);
    }

    // Agent layer host=node must win over global gateway and still deny.
    spawned = false;
    const agentDeny = await runCronJobPrecheck(
      { command: "echo WORK_NEEDED" },
      {
        spawnImpl,
        authz: {
          triggersEnabled: true,
          toolsAllow,
          toolsExec: { host: "gateway", security: "full" },
          agentToolsExec: { host: "node", node: "edge-1", security: "full" },
        },
      },
    );
    expect(agentDeny.decision).toBe("error");
    if (agentDeny.decision === "error") {
      expect(agentDeny.reason).toMatch(/host=node/);
      expect(agentDeny.reason).toMatch(/edge-1/);
    }
    expect(spawned).toBe(false);

    // Explicit gateway still allowed through host gate (may still hit other policy).
    const gatewayOk = await authorizeCronJobPrecheckCommand({
      command: "echo ok",
      authz: {
        triggersEnabled: true,
        toolsAllow,
        toolsExec: { host: "gateway", security: "full" },
        securityOverrideOnly: true,
        security: "full",
      },
    });
    expect(gatewayOk.allowed).toBe(true);
  });

  it("runs a real shell check for exit 2 skip when policy allows", async () => {
    const result = await runCronJobPrecheck({ command: "exit 2" }, { authz: AUTH_FULL });
    expect(result.decision).toBe("skip");
  });

  it("runs a real shell check for exit 0 work when policy allows", async () => {
    const result = await runCronJobPrecheck({ command: "exit 0" }, { authz: AUTH_FULL });
    expect(result.decision).toBe("run");
  });

  it("does not spawn after abort before run", async () => {
    const controller = new AbortController();
    let spawnCount = 0;
    const spawnImpl = ((..._args: unknown[]) => {
      spawnCount += 1;
      throw new Error("spawn should not be called after abort");
    }) as unknown as typeof import("node:child_process").spawn;
    controller.abort();
    const result = await runCronJobPrecheck(
      { command: "echo hi" },
      {
        abortSignal: controller.signal,
        spawnImpl,
        authz: AUTH_FULL,
      },
    );
    expect(result.decision).toBe("error");
    expect(spawnCount).toBe(0);
  });

  it("terminates precheck process tree on timeout", async () => {
    const marker = path.join(os.tmpdir(), `oc-precheck-tree-${process.pid}-${Date.now()}.pid`);
    // Background sleep should die with process-tree termination, not only the shell root.
    const command = `sleep 600 & echo $! > "${marker}"; wait`;
    const result = await runCronJobPrecheck({ command, timeoutMs: 250 }, { authz: AUTH_FULL });
    expect(result.decision).toBe("error");
    if (result.decision === "error") {
      expect(result.reason).toMatch(/precheck-timeout/);
    }
    await new Promise<void>((r) => {
      setTimeout(r, 400);
    });
    if (fs.existsSync(marker)) {
      const pid = Number(fs.readFileSync(marker, "utf8").trim());
      try {
        fs.unlinkSync(marker);
      } catch {
        // ignore
      }
      if (Number.isFinite(pid) && pid > 0) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      }
    }
  });

  it("strips dangerous inherited env (BASH_ENV) before spawn", async () => {
    const prev = process.env.BASH_ENV;
    process.env.BASH_ENV = "/tmp/should-not-reach-precheck-shell";
    let sawEnv: NodeJS.ProcessEnv | undefined;
    try {
      const spawnImpl = ((cmd: unknown, args: unknown, opts: { env?: NodeJS.ProcessEnv }) => {
        sawEnv = opts?.env;
        // Minimal child mock that exits 0 immediately
        const makeStream = () => {
          const s = new EventEmitter() as EventEmitter & {
            setEncoding: (enc: string) => void;
          };
          s.setEncoding = () => {};
          return s;
        };
        const ee = new EventEmitter() as EventEmitter & {
          stdout: ReturnType<typeof makeStream>;
          stderr: ReturnType<typeof makeStream>;
          kill: () => boolean;
          pid: number;
        };
        ee.stdout = makeStream();
        ee.stderr = makeStream();
        ee.kill = () => true;
        ee.pid = 424242;
        queueMicrotask(() => {
          ee.stdout.emit("data", "WORK_NEEDED\n");
          ee.emit("close", 0);
        });
        return ee;
      }) as unknown as typeof import("node:child_process").spawn;
      const result = await runCronJobPrecheck(
        { command: "echo WORK_NEEDED" },
        { authz: AUTH_FULL, spawnImpl },
      );
      expect(result.decision).toBe("run");
      expect(sawEnv).toBeDefined();
      expect(sawEnv?.BASH_ENV).toBeUndefined();
    } finally {
      if (prev === undefined) {
        delete process.env.BASH_ENV;
      } else {
        process.env.BASH_ENV = prev;
      }
    }
  });

  it("ignores poisoned SHELL when resolving precheck executable", () => {
    const poisoned = {
      ...process.env,
      SHELL: "/tmp/evil-shell-should-not-run",
      ComSpec: "C:\\\\evil\\\\cmd.exe",
    };
    const resolved = resolveTrustedPrecheckShellCommand("echo hi", poisoned, "linux");
    expect(resolved.shell).toBe("/bin/sh");
    expect(resolved.args).toEqual(["-c", "echo hi"]);
    const win = resolveTrustedPrecheckShellCommand("echo hi", poisoned, "win32");
    expect(win.shell.toLowerCase()).not.toContain("evil");
    expect(win.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  });

  it("spawns trusted /bin/sh even when process.env.SHELL is poisoned", async () => {
    const prev = process.env.SHELL;
    process.env.SHELL = "/tmp/evil-precheck-shell";
    let sawCmd: string | undefined;
    try {
      const spawnImpl = ((cmd: unknown) => {
        sawCmd = String(cmd);
        const makeStream = () => {
          const s = new EventEmitter() as EventEmitter & {
            setEncoding: (enc: string) => void;
          };
          s.setEncoding = () => {};
          return s;
        };
        const ee = new EventEmitter() as EventEmitter & {
          stdout: ReturnType<typeof makeStream>;
          stderr: ReturnType<typeof makeStream>;
          kill: () => boolean;
          pid: number;
        };
        ee.stdout = makeStream();
        ee.stderr = makeStream();
        ee.kill = () => true;
        ee.pid = 424243;
        queueMicrotask(() => {
          ee.stdout.emit("data", "WORK_NEEDED\n");
          ee.emit("close", 0);
        });
        return ee;
      }) as unknown as typeof import("node:child_process").spawn;
      const result = await runCronJobPrecheck(
        { command: "echo WORK_NEEDED" },
        { authz: AUTH_FULL, spawnImpl },
      );
      expect(result.decision).toBe("run");
      expect(sawCmd).toBe("/bin/sh");
    } finally {
      if (prev === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = prev;
      }
    }
  });
});

describe("Windows allowlist transport (precheck)", () => {
  it("reports real cmd.exe transport facts so allowlist requires approval (fails closed unattended)", async () => {
    const { evaluateSystemRunPolicy } = await import("../node-host/exec-policy.js");
    // Mirror authorizeCronJobPrecheckCommand: pass actual Windows cmd wrapper facts.
    const blocked = evaluateSystemRunPolicy({
      security: "allowlist",
      ask: "off",
      analysisOk: true,
      allowlistSatisfied: true,
      approvalDecision: null,
      isWindows: true,
      cmdInvocation: true,
      shellWrapperInvocation: true,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.shellWrapperBlocked).toBe(true);
  });

  it("denies Windows allowlist precheck without approval (cmd transport fails closed)", async () => {
    const prev = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const result = await authorizeCronJobPrecheckCommand({
        command: "echo NO_WORK",
        authz: {
          triggersEnabled: true,
          security: "allowlist",
          securityOverrideOnly: true,
          toolsAllow: ["*"],
        },
      });
      // Real cmd.exe /c facts + unattended ask=off → policy deny (cannot prompt).
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toMatch(/cmd\.exe|shell wrapper|Windows shell|approval|allowlist/i);
      }
    } finally {
      Object.defineProperty(process, "platform", { value: prev });
    }
  });
});

describe("cronToolsAllowPermitsPrecheckExec / job toolsAllow authz", () => {
  it("denies precheck when job toolsAllow omits exec", async () => {
    const result = await authorizeCronJobPrecheckCommand({
      command: "echo hi",
      authz: {
        triggersEnabled: true,
        security: "full",
        securityOverrideOnly: true,
        toolsAllow: ["read"],
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("toolsAllow");
      expect(result.reason).toContain("exec");
    }
  });

  it("rejects unrelated *.exec plugin tool names (canonical matcher)", () => {
    expect(cronToolsAllowPermitsPrecheckExec(["vendor.exec"])).toBe(false);
    expect(cronToolsAllowPermitsPrecheckExec(["unrelated.exec", "read"])).toBe(false);
    expect(cronToolsAllowPermitsPrecheckExec(["exec"])).toBe(true);
    expect(cronToolsAllowPermitsPrecheckExec(["*"])).toBe(true);
    expect(cronToolsAllowPermitsPrecheckExec(["read", "write"])).toBe(false);
  });

  it("allows precheck when toolsAllow includes exec or wildcard", async () => {
    for (const toolsAllow of [["exec"], ["*"], ["read", "exec"]] as const) {
      const result = await authorizeCronJobPrecheckCommand({
        command: "echo hi",
        authz: {
          triggersEnabled: true,
          security: "full",
          securityOverrideOnly: true,
          toolsAllow,
        },
      });
      expect(result.allowed).toBe(true);
    }
  });

  it("denies precheck when toolsAllow is absent (fail closed)", async () => {
    for (const toolsAllow of [undefined, null] as const) {
      const result = await authorizeCronJobPrecheckCommand({
        command: "echo hi",
        authz: {
          triggersEnabled: true,
          security: "full",
          securityOverrideOnly: true,
          toolsAllow,
        },
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain("toolsAllow");
      }
    }
    expect(cronToolsAllowPermitsPrecheckExec(undefined)).toBe(false);
    expect(cronToolsAllowPermitsPrecheckExec(null)).toBe(false);
  });
});

describe("normalizeCronJobPrecheck whitespace prefixes", () => {
  it("rejects whitespace-only workStdoutPrefix / noWorkStdoutPrefix", () => {
    expect(() =>
      normalizeCronJobPrecheck({
        kind: "exec",
        command: "exit 0",
        workStdoutPrefix: "   ",
      }),
    ).toThrow(/workStdoutPrefix/);
    expect(() =>
      normalizeCronJobPrecheck({
        kind: "exec",
        command: "exit 0",
        noWorkStdoutPrefix: "\t",
      }),
    ).toThrow(/noWorkStdoutPrefix/);
  });
});

describe("runCronJobPrecheck receipt fence after authz", () => {
  it("invokes assertRunCurrent after authorization and before spawn", async () => {
    const order: string[] = [];
    const spawnImpl = ((..._args: unknown[]) => {
      order.push("spawn");
      const child = new EventEmitter() as import("node:events").EventEmitter & {
        pid: number;
        stdout: import("node:events").EventEmitter & { setEncoding: (enc: string) => void };
        stderr: import("node:events").EventEmitter & { setEncoding: (enc: string) => void };
        kill: () => boolean;
      };
      child.pid = 4242;
      child.stdout = new EventEmitter() as typeof child.stdout;
      child.stderr = new EventEmitter() as typeof child.stderr;
      child.stdout.setEncoding = () => {};
      child.stderr.setEncoding = () => {};
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.emit("data", "ok\n");
        child.emit("close", 0);
      });
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    }) as typeof import("node:child_process").spawn;

    const result = await runCronJobPrecheck(
      { command: "echo ok" },
      {
        spawnImpl,
        authz: {
          triggersEnabled: true,
          security: "full",
          securityOverrideOnly: true,
          toolsAllow: ["*"],
        },
        assertRunCurrent: () => {
          order.push("assert");
        },
      },
    );
    expect(result.decision).toBe("run");
    expect(order).toEqual(["assert", "spawn"]);
  });

  it("does not spawn when assertRunCurrent throws after authorization", async () => {
    let spawned = false;
    const spawnImpl = ((..._args: unknown[]) => {
      spawned = true;
      throw new Error("spawn should not run");
    }) as typeof import("node:child_process").spawn;

    await expect(
      runCronJobPrecheck(
        { command: "echo ok" },
        {
          spawnImpl,
          authz: {
            triggersEnabled: true,
            security: "full",
            securityOverrideOnly: true,
            toolsAllow: ["*"],
          },
          assertRunCurrent: () => {
            throw new Error("receipt-stale");
          },
        },
      ),
    ).rejects.toThrow(/receipt-stale/);
    expect(spawned).toBe(false);
  });
});
