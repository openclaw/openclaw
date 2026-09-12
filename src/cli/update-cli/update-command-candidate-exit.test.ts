import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  createNpmTarget,
  writePackageRoot,
} from "../../infra/package-update-steps.test-support.js";
import * as repairAgent from "../../infra/update-repair-agent.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import * as processRunner from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { finishUpdate } from "./update-command-post-update.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";

const mocks = vi.hoisted(() => ({
  captureManagedPreflight:
    vi.fn<
      typeof import("./update-command-managed-context.js").captureOwnedManagedUpdatePreflightContext
    >(),
  captureSchemaContext:
    vi.fn<typeof import("./schema-preflight.js").captureTargetDatabaseSchemaContext>(),
  inspectService:
    vi.fn<
      typeof import("./update-command-service.js").maybeStopManagedServiceBeforeMutableUpdate
    >(),
  validateCanary:
    vi.fn<typeof import("../../infra/update-candidate-canary.js").validateUpdateCandidateCanary>(),
}));

vi.mock("../../infra/update-candidate-canary.js", () => ({
  validateUpdateCandidateCanary: mocks.validateCanary,
}));
vi.mock("./schema-preflight.js", async (original) => ({
  ...(await original<typeof import("./schema-preflight.js")>()),
  captureTargetDatabaseSchemaContext: mocks.captureSchemaContext,
  checkTargetDatabaseSchemasForContexts: async () => ({ incompatible: [], indeterminate: [] }),
}));
vi.mock("./update-command-managed-context.js", async (original) => ({
  ...(await original<typeof import("./update-command-managed-context.js")>()),
  captureOwnedManagedUpdateContext: async () => undefined,
  captureOwnedManagedUpdatePreflightContext: mocks.captureManagedPreflight,
  revalidateUpdateDatabaseContext: async (context: unknown) => context,
}));
vi.mock("./update-command-service.js", async (original) => ({
  ...(await original<typeof import("./update-command-service.js")>()),
  maybeStopManagedServiceBeforeMutableUpdate: mocks.inspectService,
  maybeRestartServiceAfterFailedMutableUpdate: async () => undefined,
}));
vi.mock("../../infra/update-triage.js", () => ({
  prepareUpdateFailureTriage: async () => async () => ({ status: "completed", hint: "" }),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("keeps successful candidate repair separate from a failed update and its process exit", async () => {
  const base = dirs.make("candidate-repair-exit-");
  const stateDir = path.join(base, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.mkdir(stateDir);
  await fs.writeFile(configPath, "{}");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "");
  const env = { ...process.env };
  const globalRoot = path.join(base, "prefix", "lib", "node_modules");
  const target = createNpmTarget(globalRoot);
  const root = path.join(globalRoot, "openclaw");
  await writePackageRoot(root, "2026.9.3");
  const launcher = path.join(base, "prefix", "bin", "openclaw");
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  await fs.writeFile(launcher, "original launcher");
  const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
  const events: string[] = [];
  vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (argv) => {
    let stdout = "";
    if (argv.join(" ") === "npm --version") {
      stdout = "12.0.0\n";
    } else if (argv.join(" ") === "npm root -g") {
      stdout = `${globalRoot}\n`;
    } else if (argv.includes("--prefix") && (argv.includes("install") || argv.includes("i"))) {
      const prefix = argv[argv.indexOf("--prefix") + 1];
      if (!prefix) {
        throw new Error("Missing stage prefix");
      }
      await writePackageRoot(path.join(prefix, "lib", "node_modules", "openclaw"), "2026.9.4");
      await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
      await fs.writeFile(path.join(prefix, "bin", "openclaw"), "candidate launcher");
    } else {
      throw new Error(`Unexpected package command: ${argv.join(" ")}`);
    }
    return { stdout, stderr: "", code: 0, signal: null, killed: false, termination: "exit" };
  });
  const failure = (candidateRoot: string) => ({
    status: "error" as const,
    reason: "runtime-verification-failed" as const,
    phase: "snapshot" as const,
    steps: [
      {
        name: "candidate snapshot",
        command: "candidate validation",
        cwd: candidateRoot,
        durationMs: 1,
        exitCode: 1,
        stderrTail: "ENOSPC: no space left on device",
      },
    ],
    durationMs: 1,
    logTail: ["ENOSPC: no space left on device"],
  });
  mocks.validateCanary.mockImplementation(
    async ({ root: candidateRoot, rehearsal }: { root: string; rehearsal?: unknown }) => {
      events.push(rehearsal ? "rehearsal passes" : "fresh snapshot fails");
      return rehearsal
        ? { status: "ok", phase: "readiness", steps: [], durationMs: 1, logTail: [] }
        : failure(candidateRoot);
    },
  );
  vi.spyOn(repairAgent, "prepareUnattendedUpdateRepair").mockImplementation(async (repair) => {
    const validation = await repair.validate(new AbortController().signal);
    expect(validation.ok).toBe(true);
    repair.onEvent?.({ type: "stopped", status: "repaired" });
    return { status: "repaired", attempts: [], finalValidation: validation };
  });
  const configSnapshot = await readConfigFileSnapshot({
    pluginValidation: "core-only",
    observe: false,
  });
  const context = { env, readEnv: env, config: configSnapshot.config, configSnapshot };
  mocks.captureSchemaContext.mockResolvedValue(context);
  mocks.captureManagedPreflight.mockResolvedValue(context);
  mocks.inspectService.mockResolvedValue({
    stopped: false,
    inspected: true,
    runtimeInspected: true,
    running: true,
    serviceEnv: env,
  });
  const execution = await executeMutableUpdate({
    root,
    installKind: "package",
    updateInstallKind: "package",
    switchToGit: false,
    timeoutMs: 30_000,
    updateStepTimeoutMs: 30_000,
    startedAt: Date.now(),
    progress: {},
    stop: () => {},
    channel: "stable",
    tag: "2026.9.4",
    shouldRestart: false,
    managedServiceRootRedirect: null,
    recoveryState: { triageTarget: { env } },
    prepareMutableUpdate: async () => {},
    packageTargetSchemaVersions: { state: 15, agent: 19 },
    packageInstallSpec: "openclaw@2026.9.4",
    packageTargetVersion: "2026.9.4",
    packageInstallTarget: target,
    opts: { json: true, yes: true, run },
  });
  expect(execution).not.toBeNull();
  if (!execution) {
    throw new Error("Missing execution result");
  }
  expect(events, JSON.stringify(execution.result)).toEqual([
    "fresh snapshot fails",
    "rehearsal passes",
    "fresh snapshot fails",
  ]);
  expect(execution.result).toMatchObject({
    status: "error",
    reason: "runtime-verification-failed",
    before: { version: "2026.9.3" },
    after: { version: null },
  });
  expect(await fs.readFile(launcher, "utf8")).toBe("original launcher");
  expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version).toBe(
    "2026.9.3",
  );
  const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  await expect(
    withUpdateFailureTriage({ json: true, yes: true, run }, { root, env }, async () => {
      await finishUpdate({
        ...execution,
        root,
        installKindChanged: false,
        configSnapshot,
        requestedChannel: null,
        storedChannel: "stable",
        channel: "stable",
        downgradeRisk: false,
        shouldRestart: false,
        preUpdatePluginInstallRecords: {},
        updateStepTimeoutMs: 1000,
        opts: { json: true, yes: true, run },
        startedAt: Date.now(),
        controlPlaneUpdateSentinelMeta: null,
        ownedManagedUpdateEnv: env,
      });
    }),
  ).rejects.toMatchObject({ name: "ExitError", code: 1 });
  expect(output).toHaveBeenCalledWith(
    expect.objectContaining({ status: "error", reason: "runtime-verification-failed" }),
  );
  expect(getUpdateRun(run.runId, { env })).toMatchObject({
    status: "failed",
    reason: "runtime-verification-failed",
    repair: [expect.objectContaining({ status: "succeeded" })],
  });
  const childSource = path.join(base, "exit-proof.mjs");
  await fs.writeFile(
    childSource,
    `
      import fs from "node:fs/promises";
      import { runCliWithExitFinalization } from ${JSON.stringify(new URL("../one-shot-exit.ts", import.meta.url).href)};
      import { withUpdateFailureTriage } from ${JSON.stringify(new URL("./update-command-triage.ts", import.meta.url).href)};
      import { UpdateCommandFailure } from ${JSON.stringify(new URL("./update-command-result.ts", import.meta.url).href)};
      const result = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
      await runCliWithExitFinalization({
        run: () => withUpdateFailureTriage({ yes: true, json: true, dryRun: true }, { env: process.env }, async () => {
          process.stdout.write("observed-failed-update:" + result.reason + "\\n");
          throw new UpdateCommandFailure(result);
        }),
        onError: (error) => { process.stderr.write(String(error)); process.exitCode = 19; },
      });
    `,
  );
  const childResultPath = path.join(base, "failed-result.json");
  await fs.writeFile(childResultPath, JSON.stringify(execution.result));
  const child = await processRunner.runCommandBuffered(
    [process.execPath, "--import", path.resolve("scripts/tsx.mjs"), childSource, childResultPath],
    { baseEnv: env, timeoutMs: 30_000 },
  );
  expect(child.stdout.toString()).toContain("observed-failed-update:runtime-verification-failed");
  expect(child.code, child.stderr.toString()).toBe(1);
});
