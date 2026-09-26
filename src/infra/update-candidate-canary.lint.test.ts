import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  noteCommittedSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../agents/auth-profiles/path-resolve.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "../agents/auth-profiles/sqlite-json.js";
import {
  closeAuthProfileReadPool,
  readPersistedSharedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { collectSecurityWarnings } from "../commands/doctor-security.js";
import { sanitizeTriageUpdateFailure } from "../commands/triage-update.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { securityAuditFindingToHealthFinding } from "../flows/health-check-adapter.js";
import { runSecretsAudit } from "../secrets/audit.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import {
  completeCanaryCommand,
  createCanarySnapshotResult,
  FakeChild,
  renderSteps,
  stubHealthyGateway,
} from "./update-candidate-canary.test-support.js";
import { writeUpdateRunReportArtifact } from "./update-failure-report-artifact.js";
import { createUpdateRun, finishUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";
import { updateRunStepsFromResultStep, updateRunWarningMessages } from "./update-run-step.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), snapshot: vi.fn(), signal: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) =>
  (await import("./update-candidate-canary-mocks.test-support.js")).mockCanaryChildProcesses(
    await importOriginal<typeof import("node:child_process")>(),
    mocks.spawn,
  ),
);
vi.mock("../process/exec.js", async (importOriginal) => {
  const { mockCanarySnapshotCommands } =
    await import("./update-candidate-canary-mocks.test-support.js");
  return mockCanarySnapshotCommands(
    await importOriginal<typeof import("../process/exec.js")>(),
    mocks.snapshot,
  );
});
vi.mock("../process/kill-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/kill-tree.js")>()),
  signalProcessTree: mocks.signal,
}));
// These fixtures use core credential fields; bundled-plugin targets have separate audit coverage.
vi.mock("../secrets/target-registry-data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets/target-registry-data.js")>();
  return { ...actual, getSecretTargetRegistry: actual.getCoreSecretTargetRegistry };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let nextPid = 41_000;
const children = new Map<number, FakeChild>();
let lintReport: { ok: boolean; checksRun: number; findings: unknown[]; warnings: unknown[] };

function canaryStateOptions(timeoutMs?: number) {
  return { root, stateDir: root, config: {}, env: {}, timeoutMs };
}

beforeEach(async () => {
  vi.clearAllMocks();
  lintReport = { ok: true, checksRun: 1, findings: [], warnings: [] };
  root = path.join(await fs.realpath(tempDirs.make("canary-lint-")), "candidate");
  await fs.mkdir(path.join(root, "dist", "infra"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "index.js"), "");
  await fs.writeFile(path.join(root, "dist", "infra", "update-migrated-finalize.worker.js"), "");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.1" }));
  mocks.snapshot.mockImplementation(async (_command, options: { input: string }) =>
    createCanarySnapshotResult(options.input),
  );
  mocks.spawn.mockImplementation((_command: string, args: string[]) => {
    const child = new FakeChild(nextPid++);
    children.set(child.pid, child);
    if (!args.includes("gateway")) {
      completeCanaryCommand(child, args, () => ({
        pluginInventory: undefined,
        pluginErrors: false,
        runtimeContract: { state: 2, agent: 3 },
        runtimeError: false,
        lintReport,
      }));
    }
    return child;
  });
  mocks.signal.mockImplementation(
    (pid: number, _signal: string, options: { onComplete?: () => void }) => {
      children.get(pid)?.emit("close", 0);
      options.onComplete?.();
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeAuthProfileReadPool();
  closeOpenClawStateDatabaseForTest();
  for (const child of children.values()) {
    child.stdout.destroy();
    child.stderr.destroy();
  }
  children.clear();
});

describe("update candidate Doctor lint", () => {
  it("preserves the supervisor refusal after a warning and successful readiness envelope", async () => {
    const reason =
      "Doctor lint settlement refused: cleanup-uncertain; disposal-requested,kill-issued-by-abort,termination=signal.";
    const spawnNormally = mocks.spawn.getMockImplementation();
    assert(spawnNormally);
    mocks.spawn.mockImplementation((command, args: string[], options) => {
      if (!args.includes("--lint")) {
        return spawnNormally(command, args, options);
      }
      const child = new FakeChild(nextPid++);
      children.set(child.pid, child);
      queueMicrotask(() => {
        child.stderr.write("[warning] Earlier inspection warning.\n");
        child.stdout.write(`${JSON.stringify(lintReport)}\n`);
        child.stderr.write(`[openclaw] Reason: ${reason}\n`);
        child.emit("close", 2);
      });
      return child;
    });
    const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
    const result = await validateUpdateCandidateCanary({ ...canaryStateOptions(), env });
    expect(result).toMatchObject({ status: "error", phase: "lint", reason: "doctor-failed" });
    const step = result.steps.find((entry) => entry.name === "candidate-doctor-lint");
    assert(step);
    expect(step).toMatchObject({
      exitCode: 2,
      failureFacts: [{ check: "lint", code: "doctor-failed", message: reason }],
    });
    expect(step.advisory).toBeUndefined();
    const run = createUpdateRun({ trigger: "cli" }, { env });
    for (const row of result.steps.flatMap(updateRunStepsFromResultStep)) {
      recordUpdateRunStep(run.runId, row, { env });
    }
    const recorded = finishUpdateRun(
      run.runId,
      { status: "failed", reason: "doctor-failed" },
      { env },
    );
    const failure = { ...result, mode: "npm" as const, root, runId: run.runId };
    const reportPath = await writeUpdateRunReportArtifact({
      result: failure,
      report: renderUpdateRunReport(recorded),
      env,
    });
    for (const output of [
      JSON.stringify(failure),
      JSON.stringify(recorded.steps),
      renderSteps([step]),
      await fs.readFile(reportPath, "utf8"),
    ]) {
      expect(output).toContain(reason);
    }
  });

  it.each(["PLAINTEXT_FOUND", "REF_SHADOWED", "LEGACY_RESIDUE"] as const)(
    "retains candidate-reported %s as a warning in the receipt and report",
    async (code) => {
      const stateDir = path.join(root, "state");
      const configPath = path.join(root, "openclaw.json");
      const archive = path.join(
        stateDir,
        "agents/main/agent/auth-profiles.json.sqlite-import.123.bak",
      );
      const config: OpenClawConfig = {
        gateway: { mode: "local" },
        models: {
          providers: Object.fromEntries(
            Array.from({ length: 4 }, (_, index) => [
              `fixture_${"x".repeat(140)}_${index}`,
              {
                baseUrl: "https://example.invalid/v1",
                api: "openai-completions",
                apiKey: "synthetic-config-credential",
                models: [],
              },
            ]),
          ),
        },
      };
      if (code === "REF_SHADOWED") {
        config.models!.providers!.fixture = {
          baseUrl: "https://example.invalid/v1",
          api: "openai-completions",
          apiKey: { source: "env", provider: "default", id: "TEST_UPDATE_SECRET" },
          models: [],
        };
      }
      const authored = JSON.stringify(config);
      await fs.mkdir(path.dirname(archive), { recursive: true });
      await fs.writeFile(configPath, authored);
      if (code === "LEGACY_RESIDUE") {
        await fs.writeFile(archive, "opaque retained recovery bytes");
      }
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
          TEST_UPDATE_SECRET: "synthetic-env-credential",
        },
        async () => {
          const env = { ...process.env };
          const auth = {
            version: 1,
            profiles: {
              "fixture:default": {
                type: "api_key",
                provider: "fixture",
                key: "synthetic-auth-credential",
              },
            },
          };
          writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" }, { env });
          noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, env);
          writePersistedAuthProfileStoreRaw(auth);
          const audit = await runSecretsAudit({ env });
          const finding = audit.findings.find(
            (entry) =>
              entry.code === code &&
              (code !== "PLAINTEXT_FOUND" || entry.profileId === "fixture:default"),
          );
          expect(finding).toMatchObject({
            code,
            severity: "warn",
            ...(code === "PLAINTEXT_FOUND"
              ? { file: resolveSharedAuthStorePath(env), profileId: "fixture:default" }
              : code === "REF_SHADOWED"
                ? { jsonPath: "models.providers.fixture.apiKey" }
                : { file: archive }),
          });
          const guidance = (await collectSecurityWarnings(config, env)).find(
            (entry) => entry.checkId === "config.plaintext_secrets",
          )!.remediation;
          // Released Doctor does not run secrets audit. Model a candidate reporting
          // its audit code through the existing security-finding contract, including
          // a stricter policy severity; this is wire compatibility, not release attribution.
          lintReport = {
            ok: false,
            checksRun: 1,
            findings: [
              securityAuditFindingToHealthFinding({
                checkId: code,
                severity: "critical",
                title: "Secret policy",
                detail: finding!.message,
                remediation: guidance,
              }),
            ],
            warnings: [],
          };
          stubHealthyGateway();
          const result = await validateUpdateCandidateCanary({
            root,
            stateDir,
            config,
            env,
          });
          expect(result.status).toBe("ok");
          const step = result.steps.find((entry) => entry.name === "candidate-doctor-lint")!;
          expect(step).toMatchObject({
            exitCode: 1,
            advisory: { kind: "recoverable-maintenance" },
            doctorLintFindings: [expect.objectContaining({ severity: "warning" })],
          });
          const run = createUpdateRun({ trigger: "cli" }, { env });
          for (const row of result.steps.flatMap(updateRunStepsFromResultStep)) {
            recordUpdateRunStep(run.runId, row, { env });
          }
          const recorded = finishUpdateRun(run.runId, { status: "succeeded" }, { env });
          const reportPath = await writeUpdateRunReportArtifact({
            result: { ...result, status: "ok", mode: "npm", root, runId: run.runId },
            report: renderUpdateRunReport(recorded),
            env,
          });
          const markdown = await fs.readFile(reportPath, "utf8");
          const printed = renderSteps(result.steps);
          const warnings = updateRunWarningMessages(recorded.steps).join("\n");
          for (const output of [markdown, printed, warnings]) {
            expect({
              code: output.includes(code),
              configure: output.includes("openclaw secrets configure"),
              apply: output.includes("openclaw secrets apply"),
            }).toEqual({ code: true, configure: true, apply: true });
            expect(output).not.toContain(auth.profiles["fixture:default"].key);
          }
          const receipt = recorded.steps.find((row) =>
            row.step.startsWith("finalize:doctor-lint:"),
          )!;
          expect(JSON.parse(receipt.detail!)).toMatchObject({
            exitCode: 1,
            counts: { error: 0, warning: 1, info: 0 },
            omitted: 0,
          });
          expect(step.failureFacts).toBeUndefined();
          expect(await fs.readFile(configPath, "utf8")).toBe(authored);
          expect(readPersistedSharedAuthProfileStoreRaw(env)).toEqual(auth);
          if (code === "LEGACY_RESIDUE") {
            expect(await fs.readFile(archive, "utf8")).toBe("opaque retained recovery bytes");
          }
        },
      );
    },
  );

  it.each([false, true])(
    "retains posture warnings without admitting blocking lint errors (blocking: %s)",
    async (blocking) => {
      lintReport = {
        ok: !blocking,
        checksRun: 1,
        findings: blocking
          ? [{ checkId: "core/config", severity: "error", message: "Invalid configuration." }]
          : [],
        warnings: [
          {
            checkId: "core/doctor/security",
            severity: "warning",
            message: "Open group policy permits mention-gated requests.",
          },
        ],
      };
      stubHealthyGateway();
      const result = await validateUpdateCandidateCanary(canaryStateOptions());
      expect(result.status).toBe(blocking ? "error" : "ok");
      if (blocking) {
        expect(result).toMatchObject({ phase: "lint", reason: "doctor-failed" });
      }
      expect(
        updateRunWarningMessages(result.steps.flatMap(updateRunStepsFromResultStep)),
      ).toContainEqual(
        expect.stringContaining("Open group policy permits mention-gated requests."),
      );
      expect(
        result.steps.find((step) => step.name === "candidate-doctor-lint")?.doctorLintFindings,
      ).toEqual([...lintReport.findings, ...lintReport.warnings]);
    },
  );
  it("treats an older candidate's security policy error as a named advisory", async () => {
    const finding = {
      checkId: "core/doctor/security",
      severity: "error",
      message: 'Discord DMs are open: dmPolicy="open" allows anyone to DM the bot.',
    };
    lintReport = {
      ok: false,
      checksRun: 1,
      findings: [finding],
      warnings: [],
    };
    stubHealthyGateway();
    const result = await validateUpdateCandidateCanary(canaryStateOptions());
    expect(result.status).toBe("ok");
    const step = result.steps.find((entry) => entry.name === "candidate-doctor-lint");
    expect(step).toMatchObject({
      exitCode: 1,
      advisory: { kind: "recoverable-maintenance" },
    });
    expect(step?.doctorLintFindings).toEqual([{ ...finding, severity: "warning" }]);
    expect(step?.failureFacts).toBeUndefined();
  });
  it.each([
    { name: "signal", exitCode: null, signal: "SIGTERM", outputLimitExceeded: false },
    { name: "output limit after exit zero", exitCode: 0, signal: null, outputLimitExceeded: true },
    { name: "output limit after exit one", exitCode: 1, signal: null, outputLimitExceeded: true },
  ])("retains physical $name facts without accepting policy output", async (physical) => {
    const spawnNormally = mocks.spawn.getMockImplementation()!;
    mocks.spawn.mockImplementation((command, args: string[], options) => {
      if (!args.includes("--lint")) {
        return spawnNormally(command, args, options);
      }
      const child = Object.assign(new FakeChild(nextPid++), { killed: physical.signal !== null });
      children.set(child.pid, child);
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            ok: false,
            checksRun: 1,
            findings: [
              { checkId: "core/doctor/security", severity: "error", message: "DMs are open." },
            ],
          }),
        );
        if (physical.outputLimitExceeded) {
          child.stdout.write("x".repeat(1024 * 1024));
        }
        child.emit("close", physical.exitCode, physical.signal);
      });
      return child;
    });
    const result = await validateUpdateCandidateCanary(canaryStateOptions());
    expect(result).toMatchObject({ status: "error", phase: "lint", reason: "doctor-failed" });
    const step = result.steps.find((entry) => entry.name === "candidate-doctor-lint")!;
    expect(step).toMatchObject({
      exitCode: physical.exitCode,
      signal: physical.signal,
      killed: physical.signal !== null,
      termination: physical.signal ? "signal" : "exit",
      outputLimitExceeded: physical.outputLimitExceeded,
    });
    expect(step.advisory).toBeUndefined();
    expect(step.doctorLintFindings).toBeDefined();
    const failure = { ...result, mode: "npm" as const, root };
    expect(updateRunStepsFromResultStep(step)[0]).toMatchObject({
      status: "failed",
      exitCode: physical.exitCode,
      failureFacts: step.failureFacts,
    });
    expect(renderSteps([step])).toContain(
      physical.outputLimitExceeded && physical.exitCode === 0
        ? "Update health check output exceeded the inspection limit"
        : "Update health check failed",
    );
    expect(renderUpdateRunReport(updateRunReportInputFromResult(failure)).markdown).toContain(
      "Failed: candidate-doctor-lint",
    );
    expect(
      sanitizeTriageUpdateFailure({ result: failure }, { env: {}, stateDir: root }),
    ).toMatchObject({
      result: {
        steps: [expect.objectContaining({ name: step.name, exitCode: physical.exitCode })],
      },
    });
  });
  it("preserves bounded Doctor findings before the diagnostic log tail", async () => {
    const spawnNormally = mocks.spawn.getMockImplementation()!;
    mocks.spawn.mockImplementation((command, args: string[], options) => {
      if (!args.includes("--lint")) {
        return spawnNormally(command, args, options);
      }
      const child = new FakeChild(nextPid++);
      queueMicrotask(() => {
        child.stdout.write(
          `${JSON.stringify({
            ok: false,
            checksRun: 1,
            findings: [
              ...Array.from({ length: 40 }, (_, index) => ({
                checkId: `optional.warning.${index}`,
                severity: "warning",
                message: "Optional check was skipped.",
              })),
              ...Array.from({ length: 8 }, (_, index) => ({
                checkId: `config.invalid.${index}`,
                severity: "error",
                path: "mcp.servers.example",
                message:
                  "Invalid server at /Users/synthetic/private/config.json token=synthetic-canary-secret",
                requirement: "connect ECONNREFUSED private-host.example:8443",
              })),
            ],
          })}\n`,
        );
        child.stderr.write(Array.from({ length: 60 }, (_, index) => `cleanup ${index}\n`).join(""));
        child.emit("close", 1);
      });
      return child;
    });
    const onStep = vi.fn();
    const env = { API_TOKEN: "synthetic-canary-secret" };
    const options = { ...canaryStateOptions(3_000), env, onStep };
    const result = await validateUpdateCandidateCanary(options);
    expect(result).toMatchObject({ status: "error", phase: "lint" });
    expect(result.steps.at(-1)).toMatchObject({
      failureFacts: Array.from({ length: 5 }, (_, index) => ({
        check: `config.invalid.${index}`,
        code: "doctor-failed",
        affectedKey: "mcp.servers.example",
        message: expect.stringContaining("Invalid server"),
      })),
    });
    expect(onStep).toHaveBeenLastCalledWith(result.steps.at(-1));
    expect(result.steps.at(-1)?.failureFacts?.[0]?.message).toContain("ECONNREFUSED");
    const findings = result.steps.at(-1)?.doctorLintFindings;
    expect(findings).toHaveLength(48);
    expect(findings?.map((finding) => finding.checkId)).toEqual([
      ...Array.from({ length: 40 }, (_, index) => `optional.warning.${index}`),
      ...Array.from({ length: 8 }, (_, index) => `config.invalid.${index}`),
    ]);
    expect(findings?.every((finding) => finding.message.length <= 500)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-canary-secret");
    expect(JSON.stringify(result)).not.toContain("/Users/synthetic");
    expect(result.logTail.join("\n")).not.toContain("config.invalid.0");
  });
});
