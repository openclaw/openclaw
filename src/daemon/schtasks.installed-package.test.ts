import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import { inspectInstalledUpdateFailure } from "./schtasks.installed-diagnostics.test-support.js";
import {
  boundedEnv,
  resolveInstalledCellBodyTimeoutMs,
  keys,
} from "./schtasks.installed-package.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it("captures failed installed update progress without changing the ledger or retaining payloads", async () => {
  const { createUpdateRun, getUpdateRun, recordUpdateRunPhase, recordUpdateRunStep } =
    await import("../infra/update-run-ledger.js");
  const { closeOpenClawStateDatabaseAsync } = await import("../state/openclaw-state-db.js");
  const env = { OPENCLAW_STATE_DIR: temporary.make("installed-update-progress-") };
  const options = { env };
  const privatePayload = "synthetic-private-update-payload";
  try {
    const run = createUpdateRun(
      { trigger: "cli", origin: { nextAction: privatePayload } },
      options,
    );
    recordUpdateRunPhase(run.runId, "validating", {}, options);
    recordUpdateRunStep(
      run.runId,
      {
        step: "global update",
        status: "completed",
        startedAtMs: 100,
        endedAtMs: 200,
        detail: privatePayload,
      },
      options,
    );
    const before = getUpdateRun(run.runId, options);
    const observed = await inspectInstalledUpdateFailure({ env, stateDir: env.OPENCLAW_STATE_DIR });
    expect(observed).toMatchObject({ phase: "validating", status: "running" });
    expect(observed).toHaveProperty(
      "steps",
      expect.arrayContaining([
        { step: "global update", status: "completed", startedAtMs: 100, endedAtMs: 200 },
      ]),
    );
    expect(JSON.stringify(observed)).not.toContain(privatePayload);
    expect(observed).not.toHaveProperty("origin");
    expect(getUpdateRun(run.runId, options)).toEqual(before);
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
});

it("reports unavailable installed progress without creating a missing database", async () => {
  const { readdir } = await import("node:fs/promises");
  const root = temporary.make("installed-update-no-ledger-");
  await expect(
    inspectInstalledUpdateFailure({ env: { OPENCLAW_STATE_DIR: root }, stateDir: root }),
  ).resolves.toEqual({
    unavailable: "No recorded update run",
  });
  expect(await readdir(root)).toEqual([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["PSMODULEANALYSISCACHEPATH", "PSModuleAnalysisCachePath"])(
  "preserves native %s and mixed-case Path while isolating application state",
  (cacheKey) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    for (const key of Object.keys(process.env)) {
      if (["PATH", "APPDATA", "TEMP", "PSMODULEANALYSISCACHEPATH"].includes(key.toUpperCase())) {
        vi.stubEnv(key, undefined);
      }
    }
    const nativePath = "C:\\native-tools";
    const moduleCache = "C:\\native-cache\\ModuleAnalysisCache";
    vi.stubEnv("Path", nativePath);
    vi.stubEnv(cacheKey, moduleCache);
    vi.stubEnv("appData", "C:\\native-profile\\roaming");
    vi.stubEnv("temp", "C:\\native-temp");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-do-not-forward");
    vi.stubEnv("NODE_OPTIONS", "--inspect");
    const root = path.resolve("synthetic-installed-fixture");
    const prefix = path.join(root, "prefix");
    const result = boundedEnv(root, prefix);

    expect(resolveEnvironmentValue(result, "PATH", "win32")).toContain(nativePath);
    expect(Object.keys(result).filter((key) => key.toUpperCase() === "PATH")).toHaveLength(1);
    expect(resolveEnvironmentValue(result, "APPDATA", "win32")).toBe(path.join(root, "appdata"));
    expect(resolveEnvironmentValue(result, "TEMP", "win32")).toBe(path.join(root, "tmp"));
    expect(result.OPENCLAW_STATE_DIR).toBe(path.join(root, "state"));
    expect(result.OPENCLAW_CONFIG_PATH).toBe(path.join(root, "openclaw.json"));
    expect(result.npm_config_prefix).toBe(prefix);
    expect(result.npm_config_cache).toBe(path.join(root, "npm-cache"));
    expect(result).not.toHaveProperty("OPENAI_API_KEY");
    expect(result).not.toHaveProperty("NODE_OPTIONS");
    expect(resolveEnvironmentValue(result, "PSMODULEANALYSISCACHEPATH", "win32")).toBe(moduleCache);
  },
);

it("reserves cleanup and runner time within the installed native workflow", async () => {
  const { createE2EVitestConfig } = await import("../../test/vitest/vitest.e2e.config.ts");
  const cleanupMs = z.number().int().positive().parse(createE2EVitestConfig().test?.hookTimeout);
  const workflow = z
    .object({
      jobs: z.object({
        "native-schtasks-package": z.object({
          "timeout-minutes": z.number().int().positive(),
          steps: z.array(
            z.object({
              env: z.record(z.string(), z.unknown()).optional(),
              "timeout-minutes": z.number().int().positive().optional(),
            }),
          ),
        }),
      }),
    })
    .parse(parse(readFileSync(".github/workflows/windows-testbox-probe.yml", "utf8")));
  const job = workflow.jobs["native-schtasks-package"];
  let totalStepMs = 0;
  for (const cell of keys) {
    const steps = job.steps.filter(
      (step) =>
        typeof step.env?.CI_WINDOWS_SCHTASKS_INSTALLED_INPUT === "string" &&
        step.env.CI_WINDOWS_SCHTASKS_INSTALLED_CELL === cell,
    );
    expect(steps, cell).toHaveLength(1);
    const stepMinutes = z.number().int().positive().parse(steps[0]?.["timeout-minutes"]);
    const stepMs = stepMinutes * 60_000;
    expect(stepMs, cell).toBeGreaterThanOrEqual(
      resolveInstalledCellBodyTimeoutMs(cell) + cleanupMs + 60_000,
    );
    totalStepMs += stepMs;
  }
  expect(job["timeout-minutes"]).toBe(75);
  // Setup, package preparation, evidence retention, and retirement need room outside the cells.
  expect(totalStepMs).toBeLessThan(job["timeout-minutes"] * 60_000);
});
