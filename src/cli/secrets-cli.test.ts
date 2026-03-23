import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const callGatewayFromCli = vi.fn();
const runSecretsAudit = vi.fn();
const resolveSecretsAuditExitCode = vi.fn();
const runSecretsConfigureInteractive = vi.fn();
const runSecretsApply = vi.fn();
const confirm = vi.fn();

const { defaultRuntime, runtimeLogs, runtimeErrors, resetRuntimeCapture } =
  createCliRuntimeCapture();

vi.mock("./gateway-rpc.js", () => ({
  addGatewayClientOptions: (cmd: Command) => cmd,
  callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
    callGatewayFromCli(method, opts, params, extra),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../secrets/audit.js", () => ({
  runSecretsAudit: (options: unknown) => runSecretsAudit(options),
  resolveSecretsAuditExitCode: (report: unknown, check: boolean) =>
    resolveSecretsAuditExitCode(report, check),
}));

vi.mock("../secrets/configure.js", () => ({
  runSecretsConfigureInteractive: (options: unknown) => runSecretsConfigureInteractive(options),
}));

vi.mock("../secrets/apply.js", () => ({
  runSecretsApply: (options: unknown) => runSecretsApply(options),
}));

vi.mock("@clack/prompts", () => ({
  confirm: (options: unknown) => confirm(options),
}));

const { registerSecretsCli } = await import("./secrets-cli.js");

describe("secrets CLI", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerSecretsCli(program);
    return program;
  };

  beforeEach(() => {
    resetRuntimeCapture();
    callGatewayFromCli.mockReset();
    runSecretsAudit.mockReset();
    resolveSecretsAuditExitCode.mockReset();
    runSecretsConfigureInteractive.mockReset();
    runSecretsApply.mockReset();
    confirm.mockReset();
  });

  it("calls secrets.reload and prints human output", async () => {
    callGatewayFromCli.mockResolvedValue({ ok: true, warningCount: 1 });
    await createProgram().parseAsync(["secrets", "reload"], { from: "user" });
    expect(callGatewayFromCli).toHaveBeenCalledWith(
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
    await createProgram().parseAsync(["secrets", "reload", "--json"], { from: "user" });
    expect(runtimeLogs.at(-1)).toContain('"ok": true');
  });

  it("runs secrets audit and exits via check code", async () => {
    runSecretsAudit.mockResolvedValue({
      version: 1,
      status: "findings",
      filesScanned: [],
      summary: {
        plaintextCount: 1,
        unresolvedRefCount: 0,
        shadowedRefCount: 0,
        legacyResidueCount: 0,
      },
      resolution: {
        refsChecked: 0,
        skippedExecRefs: 0,
        resolvabilityComplete: true,
      },
      findings: [],
    });
    resolveSecretsAuditExitCode.mockReturnValue(1);

    await expect(
      createProgram().parseAsync(["secrets", "audit", "--check"], { from: "user" }),
    ).rejects.toBeTruthy();
    expect(runSecretsAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        allowExec: false,
      }),
    );
    expect(resolveSecretsAuditExitCode).toHaveBeenCalledWith(expect.anything(), true);
  });

  it("forwards --allow-exec to secrets audit", async () => {
    runSecretsAudit.mockResolvedValue({
      version: 1,
      status: "clean",
      filesScanned: [],
      summary: {
        plaintextCount: 0,
        unresolvedRefCount: 0,
        shadowedRefCount: 0,
        legacyResidueCount: 0,
      },
      resolution: {
        refsChecked: 1,
        skippedExecRefs: 0,
        resolvabilityComplete: true,
      },
      findings: [],
    });
    resolveSecretsAuditExitCode.mockReturnValue(0);

    await createProgram().parseAsync(["secrets", "audit", "--allow-exec"], { from: "user" });
    expect(runSecretsAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        allowExec: true,
      }),
    );
  });

  it("runs secrets configure then apply when confirmed", async () => {
    runSecretsConfigureInteractive.mockResolvedValue({
      plan: {
        version: 1,
        protocolVersion: 1,
        generatedAt: "2026-02-26T00:00:00.000Z",
        generatedBy: "openclaw secrets configure",
        targets: [
          {
            type: "skills.entries.apiKey",
            path: "skills.entries.qa-secret-test.apiKey",
            pathSegments: ["skills", "entries", "qa-secret-test", "apiKey"],
            ref: {
              source: "env",
              provider: "default",
              id: "QA_SECRET_TEST_API_KEY",
            },
          },
        ],
      },
      preflight: {
        mode: "dry-run",
        changed: true,
        changedFiles: ["/tmp/openclaw.json"],
        checks: {
          resolvability: true,
          resolvabilityComplete: true,
        },
        refsChecked: 1,
        skippedExecRefs: 0,
        warningCount: 0,
        warnings: [],
      },
    });
    confirm.mockResolvedValue(true);
    runSecretsApply.mockResolvedValue({
      mode: "write",
      changed: true,
      changedFiles: ["/tmp/openclaw.json"],
      checks: {
        resolvability: true,
        resolvabilityComplete: true,
      },
      refsChecked: 1,
      skippedExecRefs: 0,
      warningCount: 0,
      warnings: [],
    });

    await createProgram().parseAsync(["secrets", "configure"], { from: "user" });
    expect(runSecretsConfigureInteractive).toHaveBeenCalled();
    expect(runSecretsApply).toHaveBeenCalledWith(
      expect.objectContaining({
        write: true,
        plan: expect.objectContaining({
          targets: expect.arrayContaining([
            expect.objectContaining({
              type: "skills.entries.apiKey",
              path: "skills.entries.qa-secret-test.apiKey",
            }),
          ]),
        }),
      }),
    );
    expect(runtimeLogs.at(-1)).toContain("Secrets applied");
  });

  it("forwards --agent to secrets configure", async () => {
    runSecretsConfigureInteractive.mockResolvedValue({
      plan: {
        version: 1,
        protocolVersion: 1,
        generatedAt: "2026-02-26T00:00:00.000Z",
        generatedBy: "openclaw secrets configure",
        targets: [],
      },
      preflight: {
        mode: "dry-run",
        changed: false,
        changedFiles: [],
        checks: {
          resolvability: true,
          resolvabilityComplete: true,
        },
        refsChecked: 0,
        skippedExecRefs: 0,
        warningCount: 0,
        warnings: [],
      },
    });
    confirm.mockResolvedValue(false);

    await createProgram().parseAsync(["secrets", "configure", "--agent", "ops"], { from: "user" });
    expect(runSecretsConfigureInteractive).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
        allowExecInPreflight: false,
      }),
    );
  });

  it("forwards --allow-exec to secrets apply dry-run", async () => {
    const planPath = path.join(
      os.tmpdir(),
      `openclaw-secrets-cli-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    await fs.writeFile(
      planPath,
      `${JSON.stringify({
        version: 1,
        protocolVersion: 1,
        generatedAt: new Date().toISOString(),
        generatedBy: "manual",
        targets: [],
      })}\n`,
      "utf8",
    );
    runSecretsApply.mockResolvedValue({
      mode: "dry-run",
      changed: false,
      changedFiles: [],
      checks: {
        resolvability: true,
        resolvabilityComplete: true,
      },
      refsChecked: 0,
      skippedExecRefs: 0,
      warningCount: 0,
      warnings: [],
    });

    await createProgram().parseAsync(
      ["secrets", "apply", "--from", planPath, "--dry-run", "--allow-exec"],
      {
        from: "user",
      },
    );
    expect(runSecretsApply).toHaveBeenCalledWith(
      expect.objectContaining({
        write: false,
        allowExec: true,
      }),
    );
    await fs.rm(planPath, { force: true });
  });

  it("forwards --allow-exec to secrets apply write mode", async () => {
    const planPath = path.join(
      os.tmpdir(),
      `openclaw-secrets-cli-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    await fs.writeFile(
      planPath,
      `${JSON.stringify({
        version: 1,
        protocolVersion: 1,
        generatedAt: new Date().toISOString(),
        generatedBy: "manual",
        targets: [],
      })}\n`,
      "utf8",
    );
    runSecretsApply.mockResolvedValue({
      mode: "write",
      changed: false,
      changedFiles: [],
      checks: {
        resolvability: true,
        resolvabilityComplete: true,
      },
      refsChecked: 0,
      skippedExecRefs: 0,
      warningCount: 0,
      warnings: [],
    });

    await createProgram().parseAsync(["secrets", "apply", "--from", planPath, "--allow-exec"], {
      from: "user",
    });
    expect(runSecretsApply).toHaveBeenCalledWith(
      expect.objectContaining({
        write: true,
        allowExec: true,
      }),
    );
    await fs.rm(planPath, { force: true });
  });

  it("does not print skipped-exec note when apply dry-run skippedExecRefs is zero", async () => {
    const planPath = path.join(
      os.tmpdir(),
      `openclaw-secrets-cli-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    await fs.writeFile(
      planPath,
      `${JSON.stringify({
        version: 1,
        protocolVersion: 1,
        generatedAt: new Date().toISOString(),
        generatedBy: "manual",
        targets: [],
      })}\n`,
      "utf8",
    );
    runSecretsApply.mockResolvedValue({
      mode: "dry-run",
      changed: false,
      changedFiles: [],
      checks: {
        resolvability: true,
        resolvabilityComplete: false,
      },
      refsChecked: 0,
      skippedExecRefs: 0,
      warningCount: 0,
      warnings: [],
    });

    await createProgram().parseAsync(["secrets", "apply", "--from", planPath, "--dry-run"], {
      from: "user",
    });
    expect(runtimeLogs.some((line) => line.includes("Secrets apply dry-run note: skipped"))).toBe(
      false,
    );
    await fs.rm(planPath, { force: true });
  });

  it("does not print skipped-exec note when configure preflight skippedExecRefs is zero", async () => {
    runSecretsConfigureInteractive.mockResolvedValue({
      plan: {
        version: 1,
        protocolVersion: 1,
        generatedAt: "2026-02-26T00:00:00.000Z",
        generatedBy: "openclaw secrets configure",
        targets: [],
      },
      preflight: {
        mode: "dry-run",
        changed: false,
        changedFiles: [],
        checks: {
          resolvability: true,
          resolvabilityComplete: false,
        },
        refsChecked: 0,
        skippedExecRefs: 0,
        warningCount: 0,
        warnings: [],
      },
    });
    confirm.mockResolvedValue(false);

    await createProgram().parseAsync(["secrets", "configure"], { from: "user" });
    expect(runtimeLogs.some((line) => line.includes("Preflight note: skipped"))).toBe(false);
  });

  it("forwards --allow-exec to configure preflight and apply", async () => {
    runSecretsConfigureInteractive.mockResolvedValue({
      plan: {
        version: 1,
        protocolVersion: 1,
        generatedAt: "2026-02-26T00:00:00.000Z",
        generatedBy: "openclaw secrets configure",
        targets: [],
      },
      preflight: {
        mode: "dry-run",
        changed: false,
        changedFiles: [],
        checks: {
          resolvability: true,
          resolvabilityComplete: true,
        },
        refsChecked: 0,
        skippedExecRefs: 0,
        warningCount: 0,
        warnings: [],
      },
    });
    runSecretsApply.mockResolvedValue({
      mode: "write",
      changed: false,
      changedFiles: [],
      checks: {
        resolvability: true,
        resolvabilityComplete: true,
      },
      refsChecked: 0,
      skippedExecRefs: 0,
      warningCount: 0,
      warnings: [],
    });

    await createProgram().parseAsync(["secrets", "configure", "--apply", "--yes", "--allow-exec"], {
      from: "user",
    });
    expect(runSecretsConfigureInteractive).toHaveBeenCalledWith(
      expect.objectContaining({
        allowExecInPreflight: true,
      }),
    );
    expect(runSecretsApply).toHaveBeenCalledWith(
      expect.objectContaining({
        write: true,
        allowExec: true,
      }),
    );
  });
});
