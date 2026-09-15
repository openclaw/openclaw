import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import { readRestartSentinelReadOnly, writeRestartSentinel } from "../../infra/restart-sentinel.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import { buildUpdateRestartSentinelPayload } from "../../infra/update-restart-sentinel-payload.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  finishSuccessfulPackageSwitch,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";
import { markControlPlaneUpdateRestartSentinelFailureBestEffort } from "./update-command-result.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";

// The finalizer, environment restoration, notice policy, and both SQLite stores
// stay real. Plugin convergence and service work have already completed.
vi.mock("./update-command-convergence.js", () => ({
  convergeUpdatePlugins: async (params: { result: unknown }) => ({
    resultWithPostUpdate: params.result,
    postUpdateConfigSnapshot: validConfigSnapshot,
  }),
}));
vi.mock("./update-command-service.js", async (original) => ({
  ...(await original<typeof import("./update-command-service.js")>()),
  maybeRestartService: async () => "ok",
  tryInstallShellCompletion: async () => undefined,
}));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  tryWriteCompletionCache: async () => undefined,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
let base: string;
let callerEnv: NodeJS.ProcessEnv;
let serviceEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  base = await fs.realpath(dirs.make("update-sentinel-env-"));
  const temporary = path.join(base, "private-tmp");
  await fs.mkdir(temporary, { mode: 0o700 });
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(base, "caller-state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(base, "caller-state", "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "");
  callerEnv = { ...process.env };
  serviceEnv = {
    ...callerEnv,
    OPENCLAW_STATE_DIR: path.join(base, "service-state"),
    OPENCLAW_CONFIG_PATH: path.join(base, "service-state", "openclaw.json"),
  };
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  await writeRestartSentinel(
    { kind: "restart", status: "ok", ts: 1, message: "unrelated caller notice" },
    callerEnv,
  );
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("update sentinel state after managed environment restoration", () => {
  it.each(["cli", "api"] as const)(
    "uses the admitted %s run for deferred notification policy and storage",
    async (trigger) => {
      const packageRoot = path.join(base, "package");
      await writePackageRoot(packageRoot, "1.0.0");
      const run: NonNullable<UpdateCommandOptions["run"]> = {
        runId: createUpdateRun(
          {
            trigger,
            ...(trigger === "api" ? { origin: { sessionKey: "agent:ops:main" } } : {}),
          },
          { env: serviceEnv },
        ).runId,
        env: serviceEnv,
      };
      const callerBefore = await readRestartSentinelReadOnly(callerEnv);
      expect(getUpdateRun(run.runId, { env: callerEnv })).toBeUndefined();

      await withUpdateCommandTerminalResult(async (registerRun) => {
        registerRun(run);
        await withOwnedManagedUpdateEnv(serviceEnv, () =>
          finishSuccessfulPackageSwitch(
            { packageRoot, run, json: true },
            {
              coreAlreadyCurrent: true,
              mutationStarted: false,
              shouldRestart: false,
              installKindChanged: false,
              downgradeRisk: false,
              ownedManagedUpdateEnv: serviceEnv,
              controlPlaneUpdateSentinelMeta: { runId: run.runId },
            },
          ),
        );
        expect(process.env.OPENCLAW_STATE_DIR).toBe(callerEnv.OPENCLAW_STATE_DIR);
        // The terminal owner has not published yet; the outer scope is already restored.
        expect(await readRestartSentinelReadOnly(serviceEnv)).toBeNull();
      });

      expect(await readRestartSentinelReadOnly(callerEnv)).toEqual(callerBefore);
      expect(getUpdateRun(run.runId, { env: serviceEnv })?.status).toBe("succeeded");
      const sentinel = await readRestartSentinelReadOnly(serviceEnv);
      if (trigger === "cli") {
        expect(sentinel).toBeNull();
      } else {
        expect(sentinel?.payload).toMatchObject({
          kind: "update",
          status: "ok",
          sessionKey: "agent:ops:main",
          stats: { runId: run.runId },
        });
      }
    },
  );

  it("marks only the selected state's matching pending sentinel after restoration", async () => {
    const run = createUpdateRun(
      { trigger: "api", origin: { sessionKey: "agent:ops:main" } },
      { env: serviceEnv },
    );
    const meta = { runId: run.runId, handoffId: "original" };
    await withOwnedManagedUpdateEnv(serviceEnv, () =>
      writeRestartSentinel(
        buildUpdateRestartSentinelPayload({
          result: { status: "skipped", mode: "npm", steps: [], durationMs: 1 },
          meta: { ...meta, continuationMessage: "resume after restart" },
        }),
        serviceEnv,
      ),
    );
    const callerBefore = await readRestartSentinelReadOnly(callerEnv);
    expect(process.env.OPENCLAW_STATE_DIR).toBe(callerEnv.OPENCLAW_STATE_DIR);

    await markControlPlaneUpdateRestartSentinelFailureBestEffort({
      meta,
      reason: "restart-unhealthy",
      jsonMode: true,
      env: serviceEnv,
    });

    expect(await readRestartSentinelReadOnly(callerEnv)).toEqual(callerBefore);
    const marked = (await readRestartSentinelReadOnly(serviceEnv))?.payload;
    expect(marked).toMatchObject({
      status: "error",
      stats: { ...meta, reason: "restart-unhealthy" },
    });
    expect(marked?.continuation).toBeUndefined();
  });
});
