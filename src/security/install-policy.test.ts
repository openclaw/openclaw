import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as waitForReapTick } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { requireNodeTool } from "../../test/helpers/node-toolchain.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig, SecurityConfig } from "../config/types.openclaw.js";
import { isPidAlive } from "../shared/pid-alive.js";
import {
  killPidIfAlive,
  readPidFile,
  writeForkingNoOutputScript,
} from "../test-utils/process-tree.js";
import { runInstallPolicy, validateInstallPolicyStatic } from "./install-policy.js";

type PolicyExec = NonNullable<NonNullable<SecurityConfig["installPolicy"]>["exec"]>;

type InstallPolicyRequest = Parameters<typeof runInstallPolicy>[0]["request"];
type PolicyOptions = Pick<Parameters<typeof runInstallPolicy>[0], "env" | "logger">;
const makeFinding = (ruleId: string, message: string, fields: Record<string, unknown> = {}) => ({
  ruleId,
  severity: "warn",
  message,
  ...fields,
});
const expectFailed = (result: Awaited<ReturnType<typeof runInstallPolicy>>, reason: string) => {
  expect(result?.blocked?.code).toBe("security_scan_failed");
  expect(result?.blocked?.reason).toContain(reason);
};
const blocked = (reason: string) => ({
  blocked: { code: "security_scan_blocked", reason: `blocked by install policy: ${reason}` },
});

async function writePolicyScript(
  dir: string,
  body = `#!${process.execPath}
const fs = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
  if (process.env.ENV_FILE) {
    fs.writeFileSync(process.env.ENV_FILE, JSON.stringify({
      PATH: process.env.PATH,
      Path: process.env.Path,
    }));
  }
  if (process.env.STDERR_TEXT) {
    process.stderr.write(process.env.STDERR_TEXT);
  }
  if (process.env.EXIT_CODE) {
    process.exit(Number(process.env.EXIT_CODE));
  }
  process.stdout.write(process.env.POLICY_RESPONSE || "");
});
`,
): Promise<string> {
  const scriptPath = path.join(dir, "policy.cjs");
  await fs.writeFile(scriptPath, body, "utf8");
  await fs.chmod(scriptPath, 0o700);
  return scriptPath;
}

function baseRequest(sourcePath: string): InstallPolicyRequest {
  return {
    targetType: "skill",
    targetName: "weather",
    sourcePath,
    sourcePathKind: "directory",
    source: { kind: "clawhub", authority: "openclaw", mutable: false, network: true },
    origin: { type: "clawhub" },
    request: { kind: "skill-install", mode: "install" },
  };
}

function configWithExec(
  exec: Omit<PolicyExec, "source">,
  policy: Omit<NonNullable<SecurityConfig["installPolicy"]>, "exec"> = {},
): OpenClawConfig {
  return {
    security: { installPolicy: { enabled: true, ...policy, exec: { source: "exec", ...exec } } },
  };
}

async function expectInvalidExec(exec: Omit<PolicyExec, "source">, message: string) {
  const validation = await validateInstallPolicyStatic(configWithExec(exec));
  expect(validation.issues.map((issue) => issue.message)).toContain(message);
}

function configWithPolicy(scriptPath: string, env: Record<string, string>): OpenClawConfig {
  return configWithExec({
    command: scriptPath,
    env,
    trustedDirs: [path.dirname(scriptPath)],
    timeoutMs: 5000,
    maxOutputBytes: 16 * 1024,
  });
}

describe("runInstallPolicy", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let sourceDir: string;
  let scriptPath: string;
  let receipts: FixtureReceiptChannel;

  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
  });
  afterAll(async () => {
    await receipts?.close();
  });

  beforeEach(async () => {
    sourceDir = tempDirs.make("openclaw-install-policy-");
    scriptPath = await writePolicyScript(sourceDir);
  });

  async function writeWritableParentPolicy() {
    const dir = tempDirs.make("openclaw-install-policy-");
    const writableDir = path.join(dir, "writable-parent");
    await fs.mkdir(writableDir, { recursive: true });
    await fs.chmod(writableDir, 0o777);
    return { writableDir, writableScriptPath: await writePolicyScript(writableDir) };
  }

  function runPolicy(config: OpenClawConfig, options: PolicyOptions = {}) {
    return runInstallPolicy({ config, request: baseRequest(sourceDir), ...options });
  }

  function runResponse(response: unknown, options: Pick<PolicyOptions, "logger"> = {}) {
    return runPolicy(
      configWithPolicy(scriptPath, { POLICY_RESPONSE: JSON.stringify(response) }),
      options,
    );
  }

  function runDecision(
    decision: "allow" | "warn" | "block",
    fields: Record<string, unknown>,
    options: Pick<PolicyOptions, "logger"> = {},
  ) {
    return runResponse({ protocolVersion: 1, decision, ...fields }, options);
  }

  it("does nothing when install policy is present but not enabled", async () => {
    await expect(runPolicy({ security: { installPolicy: {} } })).resolves.toBeUndefined();
  });

  it("preserves PATH so env shebang policy scripts can start", async () => {
    if (process.platform === "win32") {
      return;
    }
    const envNodeScriptPath = await writePolicyScript(
      sourceDir,
      '#!/usr/bin/env node\nprocess.stdout.write(process.env.POLICY_RESPONSE || "");\n',
    );
    const result = await runPolicy(
      configWithExec({
        command: envNodeScriptPath,
        env: { POLICY_RESPONSE: JSON.stringify({ protocolVersion: 1, decision: "allow" }) },
        passEnv: ["PATH"],
        trustedDirs: [path.dirname(envNodeScriptPath)],
      }),
      {
        env: { PATH: path.dirname(requireNodeTool("node")) },
      },
    );
    expect(result).toEqual({});
  });

  it.runIf(process.platform !== "win32")(
    "kills forked policy command children on no-output timeout",
    async ({ signal }) => {
      const forkScriptPath = await writeForkingNoOutputScript(sourceDir, receipts.endpoint);
      const pidPath = path.join(sourceDir, "forked.pid");
      let childPid: number | undefined;
      let resultPromise: ReturnType<typeof runInstallPolicy> | undefined;
      const nativeSetTimeout = globalThis.setTimeout;
      let noOutputTimeout: (() => void) | undefined;
      const setTimeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((callback, delay, ...args) => {
          if (delay === 1_000 || delay === 10_000) {
            if (delay === 1_000) {
              noOutputTimeout = () => callback(...args);
            }
            // Neither policy deadline should race real process startup.
            const timer = nativeSetTimeout(() => undefined, delay);
            clearTimeout(timer);
            timer.refresh = () => timer;
            return timer;
          }
          return nativeSetTimeout(callback, delay, ...args);
        });

      try {
        resultPromise = runInstallPolicy({
          config: configWithExec({
            command: forkScriptPath,
            env: { NODE_BINARY: process.execPath, PID_FILE: pidPath },
            trustedDirs: [path.dirname(forkScriptPath)],
            noOutputTimeoutMs: 1_000,
            timeoutMs: 10_000,
          }),
          request: baseRequest(sourceDir),
        });
        void resultPromise.catch(() => undefined);
        // The PID record precedes the receipt; operation settlement can win the socket race.
        const settled = resultPromise.then(
          () => {
            if (!existsSync(pidPath)) {
              throw new Error(`Timed out waiting for pid file: ${pidPath}`);
            }
          },
          (error: unknown) => {
            if (!existsSync(pidPath)) {
              throw error;
            }
          },
        );
        await withinTest(Promise.race([receipts.waitFor(pidPath, "ready"), settled]), signal);
        childPid = await readPidFile(pidPath);
        expect(isPidAlive(childPid)).toBe(true);
        expectDefined(noOutputTimeout, "no-output timeout")();
        const result = await withinTest(resultPromise, signal);
        expect(result?.blocked?.reason).toContain("policy command produced no output");
        // The policy outcome does not expose the adopted descendant's native reap event.
        while (isPidAlive(childPid)) {
          await waitForReapTick(25, undefined, { signal }).catch((error: unknown) => {
            throw new Error(`Policy descendant ${childPid} stayed alive`, { cause: error });
          });
        }
        expect(isPidAlive(childPid)).toBe(false);
      } finally {
        setTimeoutSpy.mockRestore();
        noOutputTimeout?.();
        killPidIfAlive(childPid);
        await resultPromise?.catch(() => {});
      }
    },
  );

  it("does not inherit PATH unless passEnv includes it", async () => {
    const envPath = path.join(sourceDir, "env.json");
    const response = JSON.stringify({ protocolVersion: 1, decision: "allow" });
    const result = await runPolicy(
      configWithPolicy(scriptPath, { ENV_FILE: envPath, POLICY_RESPONSE: response }),
      {
        env: { PATH: "/tmp/untrusted-path" },
      },
    );
    expect(result).toEqual({});
    const captured = JSON.parse(await fs.readFile(envPath, "utf8")) as {
      PATH?: string;
      Path?: string;
    };
    expect([captured.PATH, captured.Path]).toEqual([undefined, undefined]);
  });

  it("skips skill requests when targets only include plugins", async () => {
    const config = configWithExec(
      {
        command: process.execPath,
        args: [scriptPath],
        env: { EXIT_CODE: "1" },
        trustedDirs: [path.dirname(scriptPath)],
      },
      { targets: ["plugin"] },
    );

    await expect(runPolicy(config)).resolves.toBeUndefined();
  });

  const reasonPrefix = "r".repeat(999);
  const criticalFinding = makeFinding("review", "Registry is not approved.", {
    severity: "critical",
  });
  it.each([
    [
      "UTF-16 block truncation",
      "block",
      { reason: `${reasonPrefix}🎉tail` },
      blocked(`${reasonPrefix.slice(0, 997)}...`),
    ],
    [
      "malformed fields and findings",
      "allow",
      {
        findings: [
          makeFinding("  review  ", "  Review.  ", { file: 42, line: "7", evidence: false }),
          { ruleId: 42, severity: "warn", message: "invalid required field" },
        ],
      },
      { findings: [makeFinding("review", "Review.")] },
    ],
    [
      "block findings without file or line",
      "block",
      { reason: "unapproved registry", findings: [criticalFinding] },
      { ...blocked("unapproved registry"), findings: [criticalFinding] },
    ],
  ] as const)("%s", async (_name, decision, fields, expected) => {
    expect(await runDecision(decision, fields)).toStrictEqual(expected);
  });

  it("returns warnings with their reason and findings", async () => {
    const debugLogs: string[] = [];
    const findings = [makeFinding("manual-review", "Suspicious install script.")];
    const result = await runDecision(
      "warn",
      { reason: "review this source", findings },
      { logger: { debug: (message) => debugLogs.push(message) } },
    );
    expect(result).toEqual({
      warning: {
        reason: "review this source",
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      findings,
    });
    expect(debugLogs.filter((message) => message.endsWith(": warned"))).toHaveLength(1);
  });

  it("normalizes warning finding lines to positive safe integers", async () => {
    const result = await runDecision("warn", {
      reason: "review line normalization",
      findings: [-2, 12.9, 1e100].map((line, index) =>
        makeFinding(`line-${index}`, "Review line", { line }),
      ),
    });
    const lines = result?.findings?.map((finding) => finding.line);
    expect(lines).toEqual([1, 12, Number.MAX_SAFE_INTEGER]);
  });

  it("bounds operator-facing warning text without splitting surrogate pairs", async () => {
    const longText = `${"x".repeat(996)}😀${"y".repeat(100)}`;
    const result = await runDecision("warn", {
      reason: longText,
      findings: [makeFinding(longText, longText, { file: longText, evidence: longText })],
    });
    const boundedText = [
      result?.warning?.reason,
      result?.findings?.[0]?.ruleId,
      result?.findings?.[0]?.message,
      result?.findings?.[0]?.file,
      result?.findings?.[0]?.evidence,
    ];
    for (const value of boundedText) {
      expect(value).toBeDefined();
      expect(value?.length).toBeLessThanOrEqual(1_000);
      expect(value?.endsWith("...")).toBe(true);
      expect(value?.slice(0, -3)).not.toMatch(/[\uD800-\uDBFF]$/);
    }
  });

  it("fingerprints warning reason changes beyond the display limit", async () => {
    const sharedPrefix = "r".repeat(1000);
    const first = await runDecision("warn", { reason: `${sharedPrefix}-first` });
    const second = await runDecision("warn", { reason: `${sharedPrefix}-second` });
    expect(first?.warning?.reason).toBe(second?.warning?.reason);
    expect(first?.warning?.fingerprint).not.toBe(second?.warning?.fingerprint);
  });

  it("fails closed when a warning has more valid findings than can be reviewed", async () => {
    const findings = Array.from({ length: 101 }, (_, index) =>
      makeFinding(`finding-${index}`, `Finding ${index}`),
    );
    const runWarning = async (warningFindings: typeof findings) =>
      await runDecision("warn", { reason: "review all findings", findings: warningFindings });
    const boundary = await runWarning(findings.slice(0, 100));
    const result = await runWarning(findings);
    expect(boundary?.warning).toBeDefined();
    expect(boundary?.findings).toHaveLength(100);
    expectFailed(result, "more than 100 valid findings");
    expect(result?.warning).toBeUndefined();
    expect(result?.findings).toBeUndefined();
  });

  it.each([
    [
      "missing warning reason",
      { protocolVersion: 1, decision: "warn" },
      'decision "warn" requires a non-empty reason',
    ],
    ["non-object", [], "must be a JSON object"],
    [
      "unsupported protocol version",
      { protocolVersion: 2, decision: "allow" },
      "protocolVersion must be 1",
    ],
    [
      "unknown decision",
      { protocolVersion: 1, decision: "review" },
      'decision must be "allow", "warn", or "block"',
    ],
  ])("fails closed for a %s response", async (_label, response, expected) => {
    expectFailed(await runResponse(response), expected);
  });

  async function runLoggedPolicy(env: Record<string, string>) {
    const logs: string[] = [];
    const result = await runPolicy(configWithPolicy(scriptPath, env), {
      logger: { debug: (message) => logs.push(message) },
    });
    expect(result?.blocked?.code).toBe("security_scan_failed");
    return { reason: result?.blocked?.reason, logs: logs.join("\n") };
  }

  it("fails closed on malformed policy output", async () => {
    const { reason, logs } = await runLoggedPolicy({ POLICY_RESPONSE: "not json" });
    expect(reason).toContain("install policy failed closed");
    expect(reason).toContain("invalid JSON");
    expect(logs).toContain("install policy failed closed");
  });

  it("does not expose policy command stderr in fail-closed reasons", async () => {
    const { reason, logs } = await runLoggedPolicy({
      EXIT_CODE: "7",
      STDERR_TEXT: "policy-secret-token",
    });
    expect(reason).toContain("policy command exited with code 7");
    expect(reason).not.toContain("policy-secret-token");
    expect(logs).not.toContain("policy-secret-token");
  });

  it("rejects relative policy command paths before resolving cwd", async () => {
    const result = await runPolicy(configWithExec({ command: "policy.cjs", args: [] }));
    expectFailed(result, "security.installPolicy.exec.command must be an absolute path");
  });

  it("reports static validation issues without running policy command", async () => {
    const validation = await validateInstallPolicyStatic(configWithExec({ command: "policy.cjs" }));
    expect(validation).toMatchObject({ enabled: true, targets: ["skill", "plugin"] });
    expect(validation.issues.map((issue) => issue.message)).toContain(
      "security.installPolicy.exec.command must be an absolute path.",
    );
  });

  it.each([
    {
      name: "policy commands under writable parent directories",
      field: "command",
      exec: (_safe, unsafe) => ({ command: unsafe }),
    },
    {
      name: "later interpreter script args after path-taking options",
      field: "args[2]",
      exec: (safe, unsafe) => ({ command: process.execPath, args: ["--require", safe, unsafe] }),
    },
    {
      name: "interpreter option values that embed script paths",
      field: "args[0]",
      exec: (safe, unsafe) => ({ command: process.execPath, args: [`--require=${unsafe}`, safe] }),
    },
  ] satisfies Array<{
    name: string;
    field: string;
    exec: (safe: string, unsafe: string) => Omit<PolicyExec, "source">;
  }>)("rejects $name", async ({ exec, field }) => {
    if (process.platform === "win32") {
      return;
    }
    const { writableDir, writableScriptPath } = await writeWritableParentPolicy();
    await expectInvalidExec(
      exec(scriptPath, writableScriptPath),
      `security.installPolicy.exec.${field} parent directory permissions are too open: ${writableDir}`,
    );
  });

  it.runIf(process.platform !== "win32")("rejects symlinked interpreter script args", async () => {
    const dir = tempDirs.make("openclaw-install-policy-");
    const realScriptPath = await writePolicyScript(dir);
    const symlinkScriptPath = path.join(dir, "policy-link.cjs");
    await fs.symlink(realScriptPath, symlinkScriptPath);

    await expectInvalidExec(
      { command: process.execPath, args: [symlinkScriptPath] },
      `security.installPolicy.exec.args[0] must not be a symlink: ${symlinkScriptPath}`,
    );
  });

  it.runIf(process.platform !== "win32")("rejects env before interpreter resolution", async () => {
    await expectInvalidExec(
      { command: "/usr/bin/env", args: ["-S", `node ${scriptPath}`] },
      "security.installPolicy.exec.command must not use env; configure the policy executable directly.",
    );
  });
});
