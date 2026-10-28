import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { noteCommittedSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "../agents/auth-profiles/sqlite-json.js";
import {
  closeAuthProfileReadPool,
  readPersistedSharedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { collectSecurityWarnings } from "../commands/doctor-security.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runDoctorLintChecks } from "../flows/doctor-lint-flow.js";
import { securityAuditFindingToHealthFinding } from "../flows/health-check-adapter.js";
import type { HealthCheck } from "../flows/health-checks.js";
import { runSecretsAudit } from "../secrets/audit.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import {
  type FakeChild,
  renderSteps,
  stubHealthyGateway,
  canaryOutcomeStep,
} from "./update-candidate-canary.test-support.js";
import { createCanaryHarness } from "./update-candidate-harness.test-support.js";
import { writeUpdateRunReportArtifact } from "./update-failure-report-artifact.js";
import { createUpdateRun, finishUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";
import { renderUpdateRunReport } from "./update-run-report.js";
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
let lintReport: { ok: boolean; checksRun: number; findings: unknown[]; warnings: unknown[] };
const harness = createCanaryHarness(mocks, { readFixture: () => ({ lintReport }) });
const canaryStateOptions = harness.options;

function report(findings: unknown[] = [], checksRun = 1, warnings: unknown[] = []) {
  return { ok: findings.length === 0, checksRun, findings, warnings };
}

function mockLint(complete: (child: FakeChild) => void, { killed = false, tracked = true } = {}) {
  harness.overrideSpawn("--lint", () => {
    const child = harness.child(tracked);
    child.killed = killed;
    queueMicrotask(() => complete(child));
    return child;
  });
}

type CanaryResult = Awaited<ReturnType<typeof validateUpdateCandidateCanary>>;
async function recordReport(result: CanaryResult, env: NodeJS.ProcessEnv) {
  const run = createUpdateRun({ trigger: "cli" }, { env });
  for (const row of result.steps.flatMap(updateRunStepsFromResultStep)) {
    recordUpdateRunStep(run.runId, row, { env });
  }
  const recorded = finishUpdateRun(
    run.runId,
    result.status === "ok" ? { status: "succeeded" } : { status: "failed", reason: result.reason },
    { env },
  );
  const reportPath = await writeUpdateRunReportArtifact({
    result: { ...result, mode: "npm", root, runId: run.runId },
    report: renderUpdateRunReport(recorded),
    env,
  });
  return { recorded, markdown: await fs.readFile(reportPath, "utf8") };
}

beforeEach(async () => {
  lintReport = report();
  root = await harness.reset(tempDirs.make("canary-lint-"));
});

afterEach(() => {
  harness.dispose();
  closeAuthProfileReadPool();
  closeOpenClawStateDatabaseForTest();
});

it("preserves the supervisor refusal after a warning and successful readiness envelope", async () => {
  const reason =
    "Doctor lint settlement refused: cleanup-uncertain; disposal-requested,kill-issued-by-abort,termination=signal.";
  mockLint((child) => {
    child.stderr.write("[warning] Earlier inspection warning.\n");
    child.stdout.write(`${JSON.stringify(lintReport)}\n`);
    child.stderr.write(`[openclaw] Reason: ${reason}\n`);
    child.emit("close", 2);
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
  const { markdown } = await recordReport(result, env);
  for (const output of [renderSteps([step]), markdown]) {
    expect(output).toContain(reason);
  }
});

it("retains a candidate-reported secret policy warning in the receipt and report", async () => {
  const code = "LEGACY_RESIDUE";
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  const archive = path.join(stateDir, "agents/main/agent/auth-profiles.json.sqlite-import.123.bak");
  const provider = {
    baseUrl: "https://example.invalid/v1",
    api: "openai-completions" as const,
    apiKey: "synthetic-config-credential",
    models: [],
  };
  const config: OpenClawConfig = {
    gateway: { mode: "local" },
    models: {
      providers: Object.fromEntries(
        Array.from({ length: 4 }, (_, index) => [
          `fixture_${"x".repeat(140)}_${index}`,
          { ...provider },
        ]),
      ),
    },
  };
  const authored = JSON.stringify(config);
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.writeFile(configPath, authored);
  await fs.writeFile(archive, "opaque retained recovery bytes");
  await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
    },
    async () => {
      const env = { ...process.env };
      const profile = { type: "api_key", provider: "fixture", key: "synthetic-auth-credential" };
      const auth = { version: 1, profiles: { "fixture:default": profile } };
      writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" }, { env });
      noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, env);
      writePersistedAuthProfileStoreRaw(auth);
      const audit = await runSecretsAudit({ env });
      const finding = audit.findings.find((entry) => entry.code === code);
      expect(finding).toMatchObject({ code, severity: "warn", file: archive });
      const guidance = (await collectSecurityWarnings(config, env)).find(
        (entry) => entry.checkId === "config.plaintext_secrets",
      )!.remediation;
      // Candidate wire compatibility, not attribution to the released Doctor.
      lintReport = report([
        securityAuditFindingToHealthFinding({
          checkId: code,
          severity: "critical",
          title: "Secret policy",
          detail: finding!.message,
          remediation: guidance,
        }),
      ]);
      stubHealthyGateway();
      const result = await validateUpdateCandidateCanary({ root, stateDir, config, env });
      expect(result.status).toBe("ok");
      const step = result.steps.find((entry) => entry.name === "candidate-doctor-lint")!;
      expect(step).toMatchObject({
        exitCode: 1,
        advisory: { kind: "recoverable-maintenance" },
        doctorLintFindings: [expect.objectContaining({ severity: "warning" })],
      });
      const { recorded, markdown } = await recordReport(result, env);
      const warnings = updateRunWarningMessages(recorded.steps).join("\n");
      for (const output of [markdown, renderSteps(result.steps), warnings]) {
        for (const text of [code, "openclaw secrets configure", "openclaw secrets apply"]) {
          expect(output).toContain(text);
        }
        expect(output).not.toContain(profile.key);
      }
      const receipt = recorded.steps.find((row) => row.step.startsWith("finalize:doctor-lint:"))!;
      expect(JSON.parse(receipt.detail!)).toMatchObject({
        exitCode: 1,
        counts: { error: 0, warning: 1, info: 0 },
        omitted: 0,
      });
      expect(step.failureFacts).toBeUndefined();
      expect(await fs.readFile(configPath, "utf8")).toBe(authored);
      expect(readPersistedSharedAuthProfileStoreRaw(env)).toEqual(auth);
      expect(await fs.readFile(archive, "utf8")).toBe("opaque retained recovery bytes");
    },
  );
});

it.each([0, 3])("marks budget-deferred lint advisory after %i checks", async (checksRun) => {
  lintReport = report([], checksRun, [
    {
      checkId: "core/doctor/agent-scopes",
      severity: "warning",
      errorCode: "update-inspection-deferred",
      message: "Agent scopes deferred until after activation.",
    },
  ]);
  stubHealthyGateway();
  const result = await validateUpdateCandidateCanary(canaryStateOptions());
  expect(result.status).toBe("ok");
  const step = result.steps.find((entry) => entry.name === "candidate-doctor-lint")!;
  expect(step).toMatchObject({
    exitCode: 0,
    advisory: {
      kind: "recoverable-maintenance",
      message: `Doctor deferred 1 inspection until after activation (${checksRun} ran). Run \`openclaw doctor --fix\` after the update.`,
    },
  });
  expect(step.failureFacts).toBeUndefined();
  const printed = renderSteps([step]);
  expect(printed).toMatch(/! candidate-doctor-lint/u);
  expect(printed).not.toContain("✓");
  expect(printed).toContain("Doctor deferred 1 inspection");
});

it.each([
  { name: "signal", exitCode: null, signal: "SIGTERM", outputLimitExceeded: false },
  { name: "output limit after exit zero", exitCode: 0, signal: null, outputLimitExceeded: true },
])("retains physical $name facts without accepting policy output", async (physical) => {
  lintReport = report([
    { checkId: "core/doctor/security", severity: "error", message: "DMs are open." },
  ]);
  mockLint(
    (child) => {
      child.stdout.write(
        JSON.stringify({ ok: false, checksRun: 1, findings: lintReport.findings }),
      );
      if (physical.outputLimitExceeded) {
        child.stdout.write("x".repeat(1024 * 1024));
      }
      child.emit("close", physical.exitCode, physical.signal);
    },
    { killed: physical.signal !== null },
  );
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
  expect(updateRunStepsFromResultStep(step)[0]).toMatchObject({
    status: "failed",
    exitCode: physical.exitCode,
  });
  expect(renderSteps([step])).toContain(
    physical.outputLimitExceeded
      ? "Update health check output exceeded the inspection limit"
      : `terminated by ${physical.signal}`,
  );
});
it("preserves bounded Doctor findings before the diagnostic log tail", async () => {
  lintReport = report([
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
  ]);
  mockLint(
    (child) => {
      child.stdout.write(
        `${JSON.stringify({ ok: false, checksRun: 1, findings: lintReport.findings })}\n`,
      );
      child.stderr.write(Array.from({ length: 60 }, (_, index) => `cleanup ${index}\n`).join(""));
      child.emit("close", 1);
    },
    { tracked: false },
  );
  const onStep = vi.fn();
  const env = { API_TOKEN: "synthetic-canary-secret" };
  const result = await validateUpdateCandidateCanary({
    ...canaryStateOptions(3_000),
    env,
    onStep,
  });
  expect(result).toMatchObject({ status: "error", phase: "lint" });
  const failed = canaryOutcomeStep(result.steps);
  expect(failed).toMatchObject({
    failureFacts: Array.from({ length: 5 }, (_, index) => ({
      check: `config.invalid.${index}`,
      code: "doctor-failed",
      affectedKey: "mcp.servers.example",
      message: expect.stringContaining("Invalid server"),
    })),
  });
  expect(onStep).toHaveBeenCalledWith(failed);
  expect(failed?.failureFacts?.[0]?.message).toContain("ECONNREFUSED");
  const findings = failed?.doctorLintFindings;
  expect(findings?.map((finding) => finding.checkId)).toEqual([
    ...Array.from({ length: 40 }, (_, index) => `optional.warning.${index}`),
    ...Array.from({ length: 8 }, (_, index) => `config.invalid.${index}`),
  ]);
  expect(findings?.every((finding) => finding.message.length <= 500)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("synthetic-canary-secret");
  expect(JSON.stringify(result)).not.toContain("/Users/synthetic");
  expect(result.logTail.join("\n")).not.toContain("config.invalid.0");
});

it.each([false, true])(
  "attests deployment settings before runtime isolation (drift=%s)",
  async (drift) => {
    const config: OpenClawConfig = {
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "password", password: "synthetic-password" },
        controlUi: { enabled: true },
        tailscale: { mode: "serve" },
      },
    };
    // A plugin may attest deployment settings without knowing rehearsal overrides.
    const checks: HealthCheck[] = [
      {
        id: "fixture/deployment-attestation",
        kind: "plugin",
        description: "Attest the deployment Gateway settings.",
        async detect({ cfg }) {
          const hash = createHash("sha256")
            .update(JSON.stringify({ ...cfg.gateway, auth: { mode: cfg.gateway?.auth?.mode } }))
            .digest("hex");
          return hash === "96145a3f866d78a4ff00e0b188cd75d89ec6b2ecd59555e8475811b4f2257af6"
            ? []
            : [
                {
                  checkId: "fixture/attestation-hash-mismatch",
                  severity: "error",
                  message: "Deployment Gateway settings do not match the accepted attestation.",
                },
              ];
        },
      },
    ];
    const check = (cfg: OpenClawConfig, configPath: string) =>
      runDoctorLintChecks(
        {
          mode: "lint",
          cfg,
          configPath,
          cwd: root,
          runtime: { log() {}, error() {}, exit() {} },
        },
        { checks },
      );
    const configPath = path.join(root, "openclaw.json");
    expect((await check(config, configPath)).findings).toEqual([]);
    if (drift) {
      config.gateway!.controlUi!.enabled = false;
    }
    const authored = JSON.stringify(config);
    await fs.writeFile(configPath, authored);
    harness.overrideSpawn("--lint", (_args, options) => {
      const child = harness.child(true);
      void (async () => {
        const copied: OpenClawConfig = JSON.parse(
          await fs.readFile(options.env.OPENCLAW_CONFIG_PATH!, "utf8"),
        );
        const result = await check(copied, options.env.OPENCLAW_CONFIG_PATH!);
        child.stdout.write(JSON.stringify(report([...result.findings], result.checksRun)));
        child.emit("close", result.findings.length ? 1 : 0);
      })().catch((error: unknown) => {
        child.stderr.write(String(error));
        child.emit("close", 2);
      });
      return child;
    });
    let runtimeConfig: OpenClawConfig | undefined;
    harness.overrideSpawn("gateway", (_args, options) => {
      runtimeConfig = JSON.parse(readFileSync(options.env.OPENCLAW_CONFIG_PATH!, "utf8"));
      return harness.child(true);
    });
    stubHealthyGateway();
    const result = await validateUpdateCandidateCanary({ ...canaryStateOptions(), config });
    const lint = result.steps.find((step) => step.name === "candidate-doctor-lint");
    expect(result.status).toBe(drift ? "error" : "ok");
    expect(lint?.doctorLintFindings?.map((finding) => finding.checkId) ?? []).toEqual(
      drift ? ["fixture/attestation-hash-mismatch"] : [],
    );
    if (!drift) {
      expect(runtimeConfig?.gateway).toMatchObject({
        bind: "loopback",
        auth: { mode: "token" },
        tailscale: { mode: "off" },
        controlUi: { enabled: false },
      });
      expect((await check(config, configPath)).findings).toEqual([]);
    }
    expect(await fs.readFile(configPath, "utf8")).toBe(authored);
  },
);

it.each([false, true])(
  "does not persist resolved credentials when lint fails=%s",
  async (fails) => {
    const secrets = ["synthetic-token", "synthetic-password", "Bearer synthetic-otel"];
    const config: OpenClawConfig = {
      gateway: { auth: { mode: "password", token: secrets[0], password: secrets[1] } },
      diagnostics: {
        enabled: true,
        otel: { enabled: true, captureContent: true, headers: { Authorization: secrets[2]! } },
      },
    };
    lintReport = report(
      fails ? [{ checkId: "fixture/refused", severity: "error", message: "Refused" }] : [],
    );
    let serialized = "";
    let retainedState: string | undefined;
    const remove = fs.rm.bind(fs);
    const cleanup = vi
      .spyOn(fs, "rm")
      .mockImplementation((target, options) =>
        target === retainedState ? Promise.resolve() : remove(target, options),
      );
    harness.overrideSpawn("--lint", (_args, options) => {
      serialized = readFileSync(options.env.OPENCLAW_CONFIG_PATH!, "utf8");
      retainedState = options.env.OPENCLAW_STATE_DIR;
      const child = harness.child(true);
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify(lintReport));
        child.emit("close", fails ? 1 : 0);
      });
      return child;
    });
    stubHealthyGateway();
    try {
      const result = await validateUpdateCandidateCanary({ ...canaryStateOptions(), config });
      expect(result.status).toBe(fails ? "error" : "ok");
      if (fails) {
        expect(result.phase).toBe("lint");
      }
      expect(serialized).not.toBe("");
      const retained = await fs.readFile(path.join(retainedState!, "openclaw.json"), "utf8");
      for (const value of secrets) {
        expect(serialized).not.toContain(value);
        expect(retained).not.toContain(value);
      }
      expect(JSON.parse(serialized)).toMatchObject({
        gateway: { auth: { mode: "password" } },
        diagnostics: { enabled: true, otel: { enabled: true, captureContent: true } },
      });
      expect(config.gateway?.auth?.password).toBe(secrets[1]);
      expect(config.diagnostics?.otel?.headers?.Authorization).toBe(secrets[2]);
    } finally {
      cleanup.mockRestore();
      if (retainedState) {
        await remove(retainedState, { recursive: true, force: true });
      }
    }
  },
);
