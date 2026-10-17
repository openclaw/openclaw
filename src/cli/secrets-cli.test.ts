import "../test-utils/prepare-compiled-subprocesses.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectObjectFields, mockFirstObjectArg } from "../test-utils/mock-call-assertions.js";
import { registerSecretsCli } from "./secrets-cli.js";

const execFileAsync = promisify(execFile);
const missingPlan = path.join(os.tmpdir(), "openclaw-secrets-cli-missing-plan.json");
const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  const runtime = createCliRuntimeMock(vi);
  return {
    callGatewayFromCli: vi.fn(),
    runSecretsAudit: vi.fn(),
    resolveSecretsAuditExitCode: vi.fn(),
    runSecretsConfigureInteractive: vi.fn(),
    runSecretsApply: vi.fn(),
    confirm: vi.fn(),
    ...runtime,
  };
});

const {
  callGatewayFromCli,
  runSecretsAudit,
  resolveSecretsAuditExitCode,
  runSecretsConfigureInteractive,
  runSecretsApply,
  confirm,
  defaultRuntime,
  runtimeLogs,
  runtimeErrors,
} = mocks;

vi.mock("./gateway-rpc.js", () => ({
  addGatewayClientOptions: (cmd: Command) => cmd,
  callGatewayFromCli: mocks.callGatewayFromCli,
}));

vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.defaultRuntime }));

vi.mock("./one-shot-exit.js", () => ({
  exitCliAfterOutput: (runtime: typeof mocks.defaultRuntime, exitCode: number) =>
    runtime.exit(exitCode),
}));

vi.mock("../secrets/audit.js", () => ({
  runSecretsAudit: mocks.runSecretsAudit,
  resolveSecretsAuditExitCode: mocks.resolveSecretsAuditExitCode,
}));

vi.mock("../secrets/configure.js", () => ({
  runSecretsConfigureInteractive: mocks.runSecretsConfigureInteractive,
}));

vi.mock("../secrets/apply.js", () => ({ runSecretsApply: mocks.runSecretsApply }));

vi.mock("@clack/prompts", () => ({ confirm: mocks.confirm }));

function createManualSecretsPlan(generatedBy = "manual", targets: unknown[] = []) {
  return {
    version: 1,
    protocolVersion: 1,
    generatedAt: "2026-02-26T00:00:00.000Z",
    generatedBy,
    targets,
  };
}

type ResultOptions = {
  changed?: boolean;
  resolvabilityComplete?: boolean;
};
function configureResult(options?: ResultOptions) {
  return {
    plan: createManualSecretsPlan("openclaw secrets configure"),
    preflight: applyResult(options),
  };
}

function sizedConfigureResult(bytes: number) {
  const target = {
    type: "skills.entries.apiKey",
    path: "skills.entries.qa.apiKey",
    ref: { source: "file", provider: "default", id: "/" },
  };
  const configured = {
    ...configureResult(),
    plan: createManualSecretsPlan("openclaw secrets configure", [target]),
  };
  const emptyBytes = Buffer.byteLength(`${JSON.stringify(configured.plan, null, 2)}\n`, "utf8");
  target.ref.id += "x".repeat(bytes - emptyBytes);
  expect(Buffer.byteLength(`${JSON.stringify(configured.plan, null, 2)}\n`, "utf8")).toBe(bytes);
  return configured;
}

function createAuditReport(status: string, plaintextCount = 0) {
  return {
    status,
    summary: {
      plaintextCount,
      unresolvedRefCount: 0,
      shadowedRefCount: 0,
      storeResidueCount: 0,
      legacyResidueCount: 0,
    },
    resolution: { skippedExecRefs: 0 },
    findings: [],
  };
}

function applyResult({ changed = false, resolvabilityComplete = true }: ResultOptions = {}) {
  return {
    changed,
    changedFiles: changed ? ["/tmp/openclaw.json"] : [],
    checks: { resolvabilityComplete },
    skippedExecRefs: 0,
    warningCount: 0,
    warnings: [],
  };
}

async function withPlanPath(run: (planPath: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-cli-test-"));
  const planPath = path.join(dir, "plan.json");
  try {
    await run(planPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function withPlanFile(
  run: (planPath: string) => Promise<void>,
  contents = `${JSON.stringify(createManualSecretsPlan())}\n`,
) {
  return withPlanPath(async (planPath) => {
    await fs.writeFile(planPath, contents, "utf8");
    await run(planPath);
  });
}

describe("secrets CLI", () => {
  const runSecrets = async (...args: string[]) => {
    const program = new Command();
    program.exitOverride();
    registerSecretsCli(program);
    await program.parseAsync(["secrets", ...args], { from: "user" });
  };
  const expectApplyFailure = async (planPath: string, message: string, ...args: string[]) => {
    await expect(runSecrets("apply", "--from", planPath, ...args)).rejects.toThrow("__exit__:1");
    expect(runtimeErrors.at(-1)).toContain(message);
    expect(runSecretsApply).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    vi.clearAllMocks();
    for (const mock of [
      callGatewayFromCli,
      runSecretsAudit,
      resolveSecretsAuditExitCode,
      runSecretsConfigureInteractive,
      runSecretsApply,
      confirm,
    ]) {
      mock.mockReset();
    }
    runSecretsConfigureInteractive.mockResolvedValue(configureResult());
    runSecretsApply.mockResolvedValue(applyResult());
    confirm.mockResolvedValue(false);
  });

  it("calls secrets.reload and prints human output", async () => {
    callGatewayFromCli.mockResolvedValue({ ok: true, warningCount: 1 });
    await runSecrets("reload");
    expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith(
      "secrets.reload",
      expect.anything(),
      undefined,
      expect.objectContaining({ expectFinal: false }),
    );
    expect(runtimeLogs.at(-1)).toBe("Secrets reloaded with 1 warning(s).");
    expect(runtimeErrors).toHaveLength(0);
  });

  it("prints JSON when requested", async () => {
    callGatewayFromCli.mockResolvedValue({ ok: true, warningCount: 0 });
    await runSecrets("reload", "--json");
    expect(runtimeLogs.at(-1)).toContain('"ok": true');
  });

  it("prints one JSON failure when apply cannot find its plan", async () => {
    await fs.rm(missingPlan, { force: true });
    await expect(runSecrets("apply", "--from", missingPlan, "--json")).rejects.toThrow(
      "__exit__:1",
    );
    expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    expect(runtimeLogs).toHaveLength(1);
    expect(JSON.parse(runtimeLogs[0] ?? "")).toEqual({
      ok: false,
      error: { type: "cli_error", message: `Secrets plan file not found: ${missingPlan}` },
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("explains Gateway reload failures without duplicate doctor noise", async () => {
    callGatewayFromCli.mockRejectedValue(
      new Error(
        "gateway closed (1006 abnormal closure). Gateway target: ws://127.0.0.1:18789 Source: local loopback Config: /tmp/openclaw.json Bind: loopback Possible causes: - Gateway not yet ready. Run `openclaw doctor` for diagnostics.",
      ),
    );

    await expect(runSecrets("reload")).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(
      "Could not reload secrets because the Gateway did not respond: gateway closed (1006 abnormal closure).",
    );
    expect(runtimeErrors.at(-1)).toContain("openclaw gateway status --deep");
    expect(runtimeErrors.at(-1)).not.toContain("Gateway target:");
    expect(runtimeErrors.at(-1)).not.toContain("diagnostics..");
  });

  it("writes one audit report before exiting with the check code", async () => {
    const report = createAuditReport("findings", 1);
    runSecretsAudit.mockResolvedValue(report);
    resolveSecretsAuditExitCode.mockReturnValue(1);

    await expect(runSecrets("audit", "--check", "--json")).rejects.toThrow("__exit__:1");
    expect(mockFirstObjectArg(runSecretsAudit).allowExec).toBe(false);
    expect(resolveSecretsAuditExitCode).toHaveBeenCalledExactlyOnceWith(report, true);
    expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    expect(mockFirstObjectArg(defaultRuntime.writeJson)).toBe(report);
    expect(runtimeLogs).toHaveLength(1);
    expect(runtimeErrors).toHaveLength(0);
  });

  it("forwards --allow-exec to secrets audit", async () => {
    runSecretsAudit.mockResolvedValue(createAuditReport("clean"));
    resolveSecretsAuditExitCode.mockReturnValue(0);

    await runSecrets("audit", "--allow-exec");
    expect(mockFirstObjectArg(runSecretsAudit).allowExec).toBe(true);
  });

  it.each([true, false])("one-way apply approval=%s (#83883)", async (approved) => {
    const configured = configureResult({ changed: true });
    runSecretsConfigureInteractive.mockResolvedValue(configured);
    confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(approved);
    runSecretsApply.mockResolvedValue(applyResult({ changed: true }));
    await runSecrets("configure");
    expect(runSecretsConfigureInteractive).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1]?.[0]).toMatchObject({
      message: expect.stringContaining("one-way"),
    });
    if (approved) {
      expect(runSecretsApply).toHaveBeenCalledExactlyOnceWith({
        plan: configured.plan,
        write: true,
        allowExec: false,
      });
    } else {
      expect(runSecretsApply).not.toHaveBeenCalled();
    }
    expect(runtimeLogs.at(-1)).toContain(approved ? "Secrets applied" : "Apply cancelled");
  });

  it("forwards --agent to secrets configure", async () => {
    await runSecrets("configure", "--agent", "ops");
    expectObjectFields(mockFirstObjectArg(runSecretsConfigureInteractive), {
      agentId: "ops",
      allowExecInPreflight: false,
    });
  });

  it.each([0, 1])("enforces the generated plan byte limit (excess=%i)", async (excess) => {
    await withPlanPath(async (planPath) => {
      runSecretsConfigureInteractive.mockResolvedValue(
        sizedConfigureResult(16 * 1024 * 1024 + excess),
      );
      if (excess) {
        await expect(runSecrets("configure", "--plan-out", planPath)).rejects.toThrow("__exit__:1");
        expect(runtimeErrors.at(-1)).toContain("Secrets plan exceeds 16777216 bytes");
        await expect(fs.access(planPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(confirm).not.toHaveBeenCalled();
      } else {
        await runSecrets("configure", "--plan-out", planPath);
        expect((await fs.stat(planPath)).size).toBe(16 * 1024 * 1024);
        expect(runtimeLogs).toContain(`Plan written to ${planPath}`);
      }
      expect(runSecretsApply).not.toHaveBeenCalled();
    });
  });

  it("rejects oversized secrets plan files before parsing", async () => {
    await withPlanFile(async (planPath) => {
      await fs.truncate(planPath, 16 * 1024 * 1024 + 1);
      await expectApplyFailure(planPath, "Secrets plan file exceeds 16777216 bytes", "--dry-run");
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects FIFO secrets plan paths without blocking",
    async () => {
      await withPlanFile(async (planPath) => {
        await runSecrets("apply", "--from", planPath, "--dry-run");
      });
      runSecretsApply.mockReset();
      runtimeLogs.length = 0;
      runtimeErrors.length = 0;

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-cli-fifo-"));
      const fifoPath = path.join(tmpDir, "plan.json");
      await execFileAsync("mkfifo", [fifoPath]);

      let timedOut = false;
      let timeout: NodeJS.Timeout | undefined;
      const parse = runSecrets("apply", "--from", fifoPath, "--dry-run");

      try {
        await expect(
          Promise.race([
            parse,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => {
                timedOut = true;
                reject(new Error("Timed out waiting for FIFO plan rejection"));
              }, 1_000);
            }),
          ]),
        ).rejects.toThrow("__exit__:1");

        expect(runSecretsApply).not.toHaveBeenCalled();
        expect(runtimeErrors.at(-1)).toContain("Secrets plan path is not a regular file");
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (timedOut) {
          const releaseWriter = execFileAsync("sh", ["-c", 'printf x > "$1"', "sh", fifoPath]);
          await Promise.allSettled([parse, releaseWriter]);
        }
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it("forwards --allow-exec to secrets apply write mode", async () => {
    await withPlanFile(async (planPath) => {
      await runSecrets("apply", "--from", planPath, "--allow-exec");
      expectObjectFields(mockFirstObjectArg(runSecretsApply), {
        write: true,
        allowExec: true,
      });
    });
  });

  it("shows a user-friendly error when the secrets plan file is malformed JSON", async () => {
    await withPlanFile(async (planPath) => {
      await expectApplyFailure(planPath, `Malformed JSON in secrets plan file: ${planPath}`);
    }, "{invalid json");
  });

  it("treats --help as the required --from value", async () => {
    await expectApplyFailure("--help", "Secrets plan file not found: --help");
  });

  it("preserves causes for unrelated apply errors with a similar message", async () => {
    await withPlanFile(async (planPath) => {
      runSecretsApply.mockRejectedValueOnce(
        new Error("Secrets plan file not found during apply", {
          cause: new Error("provider diagnostic"),
        }),
      );

      await expect(runSecrets("apply", "--from", planPath)).rejects.toThrow("__exit__:1");

      expect(runtimeErrors.join("\n")).toContain(
        "Secrets plan file not found during apply | provider diagnostic",
      );
    });
  });

  it.each(["apply", "configure"])("omits %s's zero skipped-exec note", async (command) => {
    runSecretsApply.mockResolvedValue(applyResult({ resolvabilityComplete: false }));
    runSecretsConfigureInteractive.mockResolvedValue(
      configureResult({ resolvabilityComplete: false }),
    );
    if (command === "apply") {
      await withPlanFile((planPath) => runSecrets("apply", "--from", planPath, "--dry-run"));
    } else {
      await runSecrets("configure");
    }
    const prefix = command === "apply" ? "Secrets apply dry-run" : "Preflight";
    const notes = runtimeLogs.filter((line) => line.includes(`${prefix} note: skipped`));
    expect(notes).toStrictEqual([]);
  });

  it("forwards --allow-exec to configure preflight and apply", async () => {
    await runSecrets("configure", "--apply", "--yes", "--allow-exec");
    expect(mockFirstObjectArg(runSecretsConfigureInteractive).allowExecInPreflight).toBe(true);
    expectObjectFields(mockFirstObjectArg(runSecretsApply), {
      write: true,
      allowExec: true,
    });
  });
});
