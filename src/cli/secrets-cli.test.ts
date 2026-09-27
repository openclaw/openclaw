import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectObjectFields,
  mockCall,
  mockFirstObjectArg,
} from "../test-utils/mock-call-assertions.js";
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
  callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
    mocks.callGatewayFromCli(method, opts, params, extra),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("./one-shot-exit.js", () => ({
  exitCliAfterOutput: (runtime: typeof mocks.defaultRuntime, exitCode: number) =>
    runtime.exit(exitCode),
}));

vi.mock("../secrets/audit.js", () => ({
  runSecretsAudit: (options: unknown) => mocks.runSecretsAudit(options),
  resolveSecretsAuditExitCode: (report: unknown, check: boolean) =>
    mocks.resolveSecretsAuditExitCode(report, check),
}));

vi.mock("../secrets/configure.js", () => ({
  runSecretsConfigureInteractive: (options: unknown) =>
    mocks.runSecretsConfigureInteractive(options),
}));

vi.mock("../secrets/apply.js", () => ({
  runSecretsApply: (options: unknown) => mocks.runSecretsApply(options),
}));

vi.mock("@clack/prompts", () => ({
  confirm: (options: unknown) => mocks.confirm(options),
}));

function createManualSecretsPlan() {
  return {
    version: 1,
    protocolVersion: 1,
    generatedAt: "2026-02-26T00:00:00.000Z",
    generatedBy: "manual",
    targets: [],
  };
}

function createConfigureInteractiveResult(options?: {
  targets?: unknown[];
  changed?: boolean;
  resolvabilityComplete?: boolean;
}) {
  return {
    plan: {
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-02-26T00:00:00.000Z",
      generatedBy: "openclaw secrets configure",
      targets: options?.targets ?? [],
    },
    preflight: createSecretsApplyResult({
      changed: options?.changed,
      resolvabilityComplete: options?.resolvabilityComplete,
    }),
  };
}

function createConfigureInteractiveResultWithPlanBytes(bytes: number) {
  const configured = createConfigureInteractiveResult({
    targets: [
      {
        type: "models.providers.apiKey",
        path: "models.providers.openai.apiKey",
        pathSegments: ["models", "providers", "openai", "apiKey"],
        ref: {
          source: "file",
          provider: "default",
          id: "",
        },
        providerId: "openai",
      },
    ],
  });
  const target = configured.plan.targets[0] as { ref: { id: string } };
  const emptyBytes = Buffer.byteLength(`${JSON.stringify(configured.plan, null, 2)}\n`, "utf8");
  target.ref.id = "x".repeat(bytes - emptyBytes);
  expect(Buffer.byteLength(`${JSON.stringify(configured.plan, null, 2)}\n`, "utf8")).toBe(bytes);
  return configured;
}

function createAuditReport(options: {
  status: string;
  plaintextCount?: number;
  unresolvedRefCount?: number;
  refsChecked?: number;
}) {
  return {
    version: 1,
    status: options.status,
    filesScanned: [],
    summary: {
      plaintextCount: options.plaintextCount ?? 0,
      unresolvedRefCount: options.unresolvedRefCount ?? 0,
      shadowedRefCount: 0,
      storeResidueCount: 0,
      legacyResidueCount: 0,
    },
    resolution: {
      refsChecked: options.refsChecked ?? 0,
      skippedExecRefs: 0,
      resolvabilityComplete: true,
    },
    findings: [],
  };
}

function createSecretsApplyResult(options?: {
  mode?: "dry-run" | "write";
  changed?: boolean;
  resolvabilityComplete?: boolean;
}) {
  return {
    mode: options?.mode ?? "dry-run",
    changed: options?.changed ?? false,
    changedFiles: options?.changed ? ["/tmp/openclaw.json"] : [],
    checks: {
      resolvability: true,
      resolvabilityComplete: options?.resolvabilityComplete ?? true,
    },
    refsChecked: 0,
    skippedExecRefs: 0,
    warningCount: 0,
    warnings: [],
  };
}

async function withPlanFile(
  run: (planPath: string) => Promise<void>,
  contents = `${JSON.stringify(createManualSecretsPlan())}\n`,
) {
  const planPath = path.join(
    os.tmpdir(),
    `openclaw-secrets-cli-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  await fs.writeFile(planPath, contents, "utf8");
  try {
    await run(planPath);
  } finally {
    await fs.rm(planPath, { force: true });
  }
}

describe("secrets CLI", () => {
  const runSecrets = async (args: string[]) => {
    const program = new Command();
    program.exitOverride();
    registerSecretsCli(program);
    await program.parseAsync(args, { from: "user" });
  };

  beforeEach(() => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGatewayFromCli.mockReset();
    runSecretsAudit.mockReset();
    resolveSecretsAuditExitCode.mockReset();
    runSecretsConfigureInteractive.mockReset();
    runSecretsApply.mockReset();
    confirm.mockReset();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it("calls secrets.reload and prints human output", async () => {
    callGatewayFromCli.mockResolvedValue({ ok: true, warningCount: 1 });
    await runSecrets(["secrets", "reload"]);
    const reloadCall = mockCall(callGatewayFromCli);
    expect(reloadCall[0]).toBe("secrets.reload");
    if (reloadCall[1] === undefined) {
      throw new Error("Expected secrets.reload params");
    }
    expect(reloadCall[2]).toBeUndefined();
    expectObjectFields(reloadCall[3], { expectFinal: false });
    expect(runtimeLogs.at(-1)).toBe("Secrets reloaded with 1 warning(s).");
    expect(runtimeErrors).toHaveLength(0);
  });

  it("prints JSON when requested", async () => {
    callGatewayFromCli.mockResolvedValue({ ok: true, warningCount: 0 });
    await runSecrets(["secrets", "reload", "--json"]);
    expect(runtimeLogs.at(-1)).toContain('"ok": true');
  });

  it.each([
    {
      name: "reload",
      prepare: () => callGatewayFromCli.mockRejectedValue(new Error("reload failed")),
      args: ["secrets", "reload", "--json"],
      exitCode: 1,
      message: "reload failed",
    },
    {
      name: "audit",
      prepare: () => runSecretsAudit.mockRejectedValue(new Error("audit failed")),
      args: ["secrets", "audit", "--json"],
      exitCode: 2,
      message: "audit failed",
    },
    {
      name: "configure",
      prepare: () =>
        runSecretsConfigureInteractive.mockRejectedValue(new Error("configure failed")),
      args: ["secrets", "configure", "--json"],
      exitCode: 1,
      message: "configure failed",
    },
    {
      name: "apply",
      prepare: async () => {
        await fs.rm(missingPlan, { force: true });
      },
      args: ["secrets", "apply", "--from", missingPlan, "--json"],
      exitCode: 1,
      message: `Secrets plan file not found: ${missingPlan}`,
    },
  ])("prints one JSON failure when $name fails", async (testCase) => {
    await testCase.prepare();

    await expect(runSecrets(testCase.args)).rejects.toThrow(`__exit__:${testCase.exitCode}`);

    expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    expect(runtimeLogs).toHaveLength(1);
    expect(JSON.parse(runtimeLogs[0] ?? "")).toEqual({
      ok: false,
      error: { type: "cli_error", message: testCase.message },
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("explains Gateway reload failures without duplicate doctor noise", async () => {
    callGatewayFromCli.mockRejectedValue(
      new Error(
        "gateway closed (1006 abnormal closure). Gateway target: ws://127.0.0.1:18789 Source: local loopback Config: /tmp/openclaw.json Bind: loopback Possible causes: - Gateway not yet ready. Run `openclaw doctor` for diagnostics.",
      ),
    );

    await expect(runSecrets(["secrets", "reload"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(
      "Could not reload secrets because the Gateway did not respond: gateway closed (1006 abnormal closure).",
    );
    expect(runtimeErrors.at(-1)).toContain("openclaw gateway status --deep");
    expect(runtimeErrors.at(-1)).not.toContain("Gateway target:");
    expect(runtimeErrors.at(-1)).not.toContain("diagnostics..");
  });

  it("writes one audit report before exiting with the check code", async () => {
    const report = createAuditReport({ status: "findings", plaintextCount: 1 });
    runSecretsAudit.mockResolvedValue(report);
    resolveSecretsAuditExitCode.mockReturnValue(1);

    await expect(runSecrets(["secrets", "audit", "--check", "--json"])).rejects.toThrow(
      "__exit__:1",
    );
    expect(mockFirstObjectArg(runSecretsAudit).allowExec).toBe(false);
    const exitCodeCall = mockCall(resolveSecretsAuditExitCode);
    if (exitCodeCall[0] === undefined) {
      throw new Error("Expected secrets audit result for exit-code resolution");
    }
    expect(exitCodeCall[1]).toBe(true);
    expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    expect(mockFirstObjectArg(defaultRuntime.writeJson)).toBe(report);
    expect(runtimeLogs).toHaveLength(1);
    expect(runtimeErrors).toHaveLength(0);
  });

  it("keeps an unresolved audit report intact at exit 2", async () => {
    const report = createAuditReport({
      status: "unresolved",
      unresolvedRefCount: 1,
      refsChecked: 1,
    });
    runSecretsAudit.mockResolvedValue(report);
    resolveSecretsAuditExitCode.mockReturnValue(2);

    await expect(runSecrets(["secrets", "audit", "--json"])).rejects.toThrow("__exit__:2");

    expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    expect(mockFirstObjectArg(defaultRuntime.writeJson)).toBe(report);
    expect(runtimeErrors).toHaveLength(0);
  });

  it("forwards --allow-exec to secrets audit", async () => {
    runSecretsAudit.mockResolvedValue(createAuditReport({ status: "clean", refsChecked: 1 }));
    resolveSecretsAuditExitCode.mockReturnValue(0);

    await runSecrets(["secrets", "audit", "--allow-exec"]);
    expect(mockFirstObjectArg(runSecretsAudit).allowExec).toBe(true);
  });

  it("emits one JSON document when --yes applies configure output", async () => {
    runSecretsConfigureInteractive.mockResolvedValue(createConfigureInteractiveResult());
    runSecretsApply.mockResolvedValue(createSecretsApplyResult({ mode: "write", changed: true }));

    await runSecrets(["secrets", "configure", "--json", "--yes"]);

    expect(runSecretsApply).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    expect(mockFirstObjectArg(defaultRuntime.writeJson)).toEqual(
      createSecretsApplyResult({ mode: "write", changed: true }),
    );
  });

  it("shows the irreversibility warning before applying configured targets (#83883)", async () => {
    const configured = createConfigureInteractiveResult({
      changed: true,
      targets: [
        {
          type: "skills.entries.apiKey",
          path: "skills.entries.qa-secret-test.apiKey",
          pathSegments: ["skills", "entries", "qa-secret-test", "apiKey"],
          ref: { source: "env", provider: "default", id: "QA_SECRET_TEST_API_KEY" },
        },
      ],
    });
    runSecretsConfigureInteractive.mockResolvedValue(configured);
    confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    runSecretsApply.mockResolvedValue(createSecretsApplyResult({ mode: "write", changed: true }));

    await runSecrets(["secrets", "configure"]);

    expect(runSecretsConfigureInteractive).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1]?.[0]).toMatchObject({
      message: expect.stringContaining("one-way"),
    });
    expect(runSecretsApply).toHaveBeenCalledExactlyOnceWith({
      plan: configured.plan,
      write: true,
      allowExec: false,
    });
    expect(runtimeLogs.at(-1)).toContain("Secrets applied");
  });

  it("cancels apply when the interactive irreversibility warning is declined (#83883)", async () => {
    runSecretsConfigureInteractive.mockResolvedValue(
      createConfigureInteractiveResult({ changed: true }),
    );
    confirm.mockResolvedValueOnce(true); // Apply this plan now?
    confirm.mockResolvedValueOnce(false); // decline the irreversibility warning

    await runSecrets(["secrets", "configure"]);

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(runSecretsApply).not.toHaveBeenCalled();
    expect(runtimeLogs.at(-1)).toContain("Apply cancelled");
  });

  it("forwards --agent to secrets configure", async () => {
    runSecretsConfigureInteractive.mockResolvedValue(createConfigureInteractiveResult());
    confirm.mockResolvedValue(false);

    await runSecrets(["secrets", "configure", "--agent", "ops"]);
    expectObjectFields(mockFirstObjectArg(runSecretsConfigureInteractive), {
      agentId: "ops",
      allowExecInPreflight: false,
    });
  });

  it("writes generated secrets plan files at the apply limit", async () => {
    const planPath = path.join(
      os.tmpdir(),
      `openclaw-secrets-configure-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    runSecretsConfigureInteractive.mockResolvedValue(
      createConfigureInteractiveResultWithPlanBytes(16 * 1024 * 1024),
    );
    confirm.mockResolvedValue(false);

    try {
      await runSecrets(["secrets", "configure", "--plan-out", planPath]);

      expect((await fs.stat(planPath)).size).toBe(16 * 1024 * 1024);
      expect(runtimeLogs).toContain(`Plan written to ${planPath}`);
      expect(runSecretsApply).not.toHaveBeenCalled();
    } finally {
      await fs.rm(planPath, { force: true });
    }
  });

  it("rejects generated secrets plan files that exceed the apply limit", async () => {
    const planPath = path.join(
      os.tmpdir(),
      `openclaw-secrets-configure-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    runSecretsConfigureInteractive.mockResolvedValue(
      createConfigureInteractiveResultWithPlanBytes(16 * 1024 * 1024 + 1),
    );

    try {
      await expect(runSecrets(["secrets", "configure", "--plan-out", planPath])).rejects.toThrow(
        "__exit__:1",
      );

      expect(runtimeErrors.at(-1)).toContain("Secrets plan exceeds 16777216 bytes");
      await expect(fs.access(planPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(confirm).not.toHaveBeenCalled();
      expect(runSecretsApply).not.toHaveBeenCalled();
    } finally {
      await fs.rm(planPath, { force: true });
    }
  });

  it("rejects oversized secrets plan files before parsing", async () => {
    await withPlanFile(async (planPath) => {
      await fs.truncate(planPath, 16 * 1024 * 1024 + 1);
      await expect(
        runSecrets(["secrets", "apply", "--from", planPath, "--dry-run"]),
      ).rejects.toThrow("__exit__:1");

      expect(runSecretsApply).not.toHaveBeenCalled();
      expect(runtimeErrors.at(-1)).toContain("Secrets plan file exceeds 16777216 bytes");
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects FIFO secrets plan paths without blocking",
    async () => {
      runSecretsApply.mockResolvedValue(createSecretsApplyResult());
      await withPlanFile(async (planPath) => {
        await runSecrets(["secrets", "apply", "--from", planPath, "--dry-run"]);
      });
      runSecretsApply.mockReset();
      runtimeLogs.length = 0;
      runtimeErrors.length = 0;

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-cli-fifo-"));
      const fifoPath = path.join(tmpDir, "plan.json");
      await execFileAsync("mkfifo", [fifoPath]);

      let timedOut = false;
      let timeout: NodeJS.Timeout | undefined;
      const parse = runSecrets(["secrets", "apply", "--from", fifoPath, "--dry-run"]);

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

  it("forwards --allow-exec to secrets apply dry-run", async () => {
    await withPlanFile(async (planPath) => {
      runSecretsApply.mockResolvedValue(createSecretsApplyResult());

      await runSecrets(["secrets", "apply", "--from", planPath, "--dry-run", "--allow-exec"]);
      expectObjectFields(mockFirstObjectArg(runSecretsApply), {
        write: false,
        allowExec: true,
      });
    });
  });

  it("forwards --allow-exec to secrets apply write mode", async () => {
    await withPlanFile(async (planPath) => {
      runSecretsApply.mockResolvedValue(createSecretsApplyResult({ mode: "write" }));

      await runSecrets(["secrets", "apply", "--from", planPath, "--allow-exec"]);
      expectObjectFields(mockFirstObjectArg(runSecretsApply), {
        write: true,
        allowExec: true,
      });
    });
  });

  it("shows a user-friendly error when the secrets plan file is malformed JSON", async () => {
    await withPlanFile(async (planPath) => {
      await expect(runSecrets(["secrets", "apply", "--from", planPath])).rejects.toThrow(
        "__exit__:1",
      );

      expect(runtimeErrors.at(-1)).toContain(`Malformed JSON in secrets plan file: ${planPath}`);
      expect(runSecretsApply).not.toHaveBeenCalled();
    }, "{invalid json");
  });

  it("rejects --from when the plan file does not exist", async () => {
    await expect(
      runSecrets(["secrets", "apply", "--from", "/nonexistent/path/plan.json"]),
    ).rejects.toThrow("__exit__:1");

    const errorOutput = runtimeErrors.join("\n");
    expect(errorOutput).toContain("Secrets plan file not found: /nonexistent/path/plan.json");
    expect(errorOutput).not.toContain("ENOENT");
    expect(runSecretsApply).not.toHaveBeenCalled();
  });

  it("treats --help as the required --from value", async () => {
    await expect(runSecrets(["secrets", "apply", "--from", "--help"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.join("\n")).toContain("Secrets plan file not found: --help");
    expect(runSecretsApply).not.toHaveBeenCalled();
  });

  it("preserves causes for unrelated apply errors with a similar message", async () => {
    await withPlanFile(async (planPath) => {
      runSecretsApply.mockRejectedValueOnce(
        new Error("Secrets plan file not found during apply", {
          cause: new Error("provider diagnostic"),
        }),
      );

      await expect(runSecrets(["secrets", "apply", "--from", planPath])).rejects.toThrow(
        "__exit__:1",
      );

      expect(runtimeErrors.join("\n")).toContain(
        "Secrets plan file not found during apply | provider diagnostic",
      );
    });
  });

  it("does not print skipped-exec note when apply dry-run skippedExecRefs is zero", async () => {
    await withPlanFile(async (planPath) => {
      runSecretsApply.mockResolvedValue(createSecretsApplyResult({ resolvabilityComplete: false }));

      await runSecrets(["secrets", "apply", "--from", planPath, "--dry-run"]);
      const skippedExecNotes = runtimeLogs.filter((line) =>
        line.includes("Secrets apply dry-run note: skipped"),
      );
      expect(skippedExecNotes).toStrictEqual([]);
    });
  });

  it("does not print skipped-exec note when configure preflight skippedExecRefs is zero", async () => {
    runSecretsConfigureInteractive.mockResolvedValue(
      createConfigureInteractiveResult({ resolvabilityComplete: false }),
    );
    confirm.mockResolvedValue(false);

    await runSecrets(["secrets", "configure"]);
    const preflightSkippedExecNotes = runtimeLogs.filter((line) =>
      line.includes("Preflight note: skipped"),
    );
    expect(preflightSkippedExecNotes).toStrictEqual([]);
  });

  it("forwards --allow-exec to configure preflight and apply", async () => {
    runSecretsConfigureInteractive.mockResolvedValue(createConfigureInteractiveResult());
    runSecretsApply.mockResolvedValue(createSecretsApplyResult({ mode: "write" }));

    await runSecrets(["secrets", "configure", "--apply", "--yes", "--allow-exec"]);
    expect(mockFirstObjectArg(runSecretsConfigureInteractive).allowExecInPreflight).toBe(true);
    expectObjectFields(mockFirstObjectArg(runSecretsApply), {
      write: true,
      allowExec: true,
    });
  });
});
