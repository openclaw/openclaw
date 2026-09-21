import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as doctorMaintenance from "../../commands/doctor-maintenance.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { VERSION } from "../../version.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";

const mocks = vi.hoisted(() => ({
  entrypoint: vi.fn(),
  runExec: vi.fn(),
  plugins: vi.fn(),
  paths: vi.fn(),
  sizes: vi.fn(),
}));
vi.mock("../../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.entrypoint,
}));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runExec: mocks.runExec,
  runUtf8CommandWithTimeout: async ([command, ...args]: string[], options: unknown) => ({
    ...(await mocks.runExec(command, args, options)),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  }),
}));
// Native binding/settlement has real-process coverage. This caller suite keeps
// both process transports inert while exercising its synthetic one-shot fence.
vi.mock("./update-command-doctor-child.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-doctor-child.js")>()),
  inspectUpdateDoctorChildSupport: async () => true,
  withUpdateDoctorChild: async (
    params: Parameters<typeof import("./update-command-doctor-child.js").withUpdateDoctorChild>[0],
    operation: Parameters<
      typeof import("./update-command-doctor-child.js").withUpdateDoctorChild
    >[1],
  ) => {
    params.context.assertRequesterCurrent();
    return await operation(async (_argv, options) => ({
      ...(await mocks.runExec(process.execPath, ["doctor", "--repair"], options)),
      code: 0,
      signal: null,
      killed: false,
      cleanup: "normal",
      termination: "exit",
    }));
  },
}));
vi.mock("../../infra/update-candidate-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-candidate-state.js")>()),
  collectStateDatabasePaths: mocks.paths,
}));
vi.mock("../../infra/update-candidate-state.sizes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-candidate-state.sizes.js")>()),
  readUpdateStateDatabaseSizes: mocks.sizes,
}));
// Package effects and process dispatch are inert. Resume, config preparation,
// plugin lease, retirement ledger, fresh Doctor and readiness remain real owners.
vi.mock("./update-command-plugins.js", () => ({ updatePluginsAfterCoreUpdate: mocks.plugins }));
vi.mock("./update-command-runtime.js", () => ({ completeSourceUpdateRuntime: vi.fn() }));

import { completePostCorePluginUpdate } from "./update-command-fresh-doctor.js";
import * as postCore from "./update-command-post-core.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";

const pluginUpdate: PostCorePluginUpdateResult = {
  status: "ok",
  changed: false,
  sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
  warnings: [],
};
let state: OpenClawTestState;
let dispatched: string[];

beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "doctor-authority-callers",
    env: {
      OPENCLAW_UPDATE_RUN_ID: undefined,
      OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: undefined,
      OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH: undefined,
      OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH: undefined,
      OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: undefined,
      // Current parents forward the start time; avoid the legacy parent ps probe.
      OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: String(Date.now()),
      OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
    },
  });
  await state.writeConfig({ plugins: { enabled: false } });
  await state.writeJson("package.json", { name: "openclaw", version: VERSION, type: "module" });
  dispatched = [];
  mocks.entrypoint.mockReset().mockResolvedValue(state.path("dist/index.js"));
  mocks.plugins.mockReset().mockResolvedValue(pluginUpdate);
  mocks.paths.mockReset().mockResolvedValue(new Map());
  mocks.sizes.mockReset().mockResolvedValue([]);
  mocks.runExec.mockReset().mockImplementation(async (_command, args: string[]) => {
    dispatched.push(
      args.includes("--repair") ? "repair" : args.includes("--lint") ? "readiness" : "validate",
    );
    return {
      stdout: args.includes("--lint")
        ? JSON.stringify({ ok: true, checksRun: 1, checksSkipped: 0, findings: [] })
        : "",
      stderr: "",
    };
  });
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await state.cleanup();
});

function firstRefusal() {
  const error = new Error("original authority refusal");
  let armed = false;
  let refused = false;
  return {
    error,
    arm: () => {
      armed = true;
    },
    assertCurrent: () => {
      if (armed && !refused) {
        refused = true;
        throw error;
      }
    },
  };
}

describe("unproved Doctor authority callers", () => {
  it.each(["2026.9.3", "2026.9.4"])(
    "keeps the shipped %s child-owned completion route outside the 9.2 bridge",
    async (version) => {
      const run = createUpdateRun({ trigger: "cli", before: { version } });
      recordUpdateRunStep(run.runId, { step: "openclaw doctor", status: "completed" });
      recordUpdateRunStep(run.runId, { step: "post-update verification", status: "in_progress" });
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", "1");
      await resumePostCoreUpdate({
        root: state.root,
        channel: "stable",
        opts: { json: true, yes: true },
        timeoutMs: 5_000,
      });
      expect(dispatched).toEqual(["repair", "validate", "readiness"]);
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: run.runId,
          steps: [expect.objectContaining({ doctorLintFindings: [] })],
        }),
      );
      expect(defaultRuntime.exit).toHaveBeenCalledExactlyOnceWith(0);
    },
  );

  it.each([false, true])(
    "publishes settled phase evidence only for older parents (parent owns completion=%s)",
    async (parentOwnsCompletion) => {
      const run = createUpdateRun({ trigger: "cli" });
      adoptUpdateRun(run.runId);
      recordUpdateRunStep(run.runId, {
        step: "finalize:doctor:model-retirement",
        status: "skipped",
      });
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", "1");
      const resultPath = state.statePath("post-core-result.json");
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", resultPath);
      if (parentOwnsCompletion) {
        await state.writeJson("handoff.json", { completionOwner: "parent" });
      }
      await fs.mkdir(state.path("phase-artifacts"));
      vi.spyOn(os, "tmpdir").mockReturnValue(state.path("phase-artifacts"));
      let restored = false;
      const maintenance = vi.spyOn(doctorMaintenance, "beginDoctorMaintenance").mockResolvedValue({
        run: (operation) => operation(),
        releaseState: async () => {},
        release: async () => {},
        finish: async () => {
          await Promise.resolve();
          restored = true;
        },
      });
      let phasePath: string | undefined;
      vi.mocked(defaultRuntime.error).mockImplementation((line) => {
        const prefix = "Post-plugin Doctor report (update completion pending): ";
        if (typeof line === "string" && line.startsWith(prefix)) {
          expect(restored).toBe(true);
          phasePath = line.slice(prefix.length);
        }
      });
      const writeResult = postCore.writePostCorePluginUpdateResultFile;
      const publication = vi
        .spyOn(postCore, "writePostCorePluginUpdateResultFile")
        .mockImplementation(async (...args) => {
          expect(getUpdateRun(run.runId)?.steps).toContainEqual(
            expect.objectContaining({ step: "finalize:doctor-lint:post-plugin-doctor-lint" }),
          );
          expect(getUpdateRun(run.runId)?.status).toBe("running");
          const canonicalPath = state.statePath("update-reports", `${run.runId}.md`);
          await expect(fs.stat(canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
          if (parentOwnsCompletion) {
            expect(phasePath).toBeUndefined();
            expect(maintenance).not.toHaveBeenCalled();
          } else {
            expect(phasePath).toBeDefined();
            expect(phasePath).not.toBe(canonicalPath);
            const report = await fs.readFile(phasePath!, "utf8");
            expect(report).toContain("update completion is pending with the parent updater");
            expect(report).toContain("Complete Doctor lint findings (0)");
          }
          await writeResult(...args);
        });

      await resumePostCoreUpdate({
        root: state.root,
        channel: "stable",
        opts: { json: true, yes: true },
        timeoutMs: 5_000,
      });

      expect(publication).toHaveBeenCalledOnce();
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
      expect(defaultRuntime.log).not.toHaveBeenCalled();
    },
  );

  it.each(["live", "paths", "sizes"] as const)(
    "fences default-budget %s await before the next child",
    async (boundary) => {
      const authority = firstRefusal();
      if (boundary !== "live") {
        const mock = boundary === "paths" ? mocks.paths : mocks.sizes;
        mock.mockImplementationOnce(async () => {
          await Promise.resolve();
          authority.arm();
          return boundary === "paths" ? new Map() : [];
        });
      }
      const result = completePostCorePluginUpdate({
        root: state.root,
        pluginUpdate,
        freshDoctorRequired: true,
        yes: true,
        json: true,
        assertCurrent: authority.assertCurrent,
      });
      if (boundary === "live") {
        expect((await result).pluginUpdate.status).toBe("ok");
        expect(dispatched).toEqual(["repair", "validate", "readiness"]);
        expect(mocks.runExec.mock.calls.map((call) => call[2].timeoutMs)).toEqual([
          undefined,
          300_000,
          300_000,
        ]);
      } else {
        await expect(result).rejects.toBe(authority.error);
        expect(dispatched).toEqual(["repair"]);
      }
    },
  );

  it.each(["live", "first-refusal"] as const)(
    "forwards original authority from real resume through deferred retirement: %s",
    async (boundary) => {
      const authority = firstRefusal();
      const run = createUpdateRun({ trigger: "cli", before: { version: VERSION } });
      recordUpdateRunStep(run.runId, {
        step: "finalize:doctor:model-retirement",
        status: "skipped",
      });
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
      // Modern parents own completion; exercise the deferred-retirement Doctor,
      // not the earlier migration Doctor required by legacy parents.
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", state.statePath("post-core-result.json"));
      await state.writeJson("handoff.json", { completionOwner: "parent" });
      if (boundary === "first-refusal") {
        mocks.entrypoint.mockImplementationOnce(async () => {
          await Promise.resolve();
          authority.arm();
          return state.path("dist/index.js");
        });
      }
      const before = await readConfigFileSnapshot({ observe: false });
      const result = resumePostCoreUpdate({
        root: state.root,
        channel: "stable",
        opts: {
          json: true,
          yes: true,
          run: { runId: run.runId, env: process.env, executorFence: authority },
        },
        timeoutMs: 5_000,
      });
      if (boundary === "live") {
        await result;
        expect(dispatched).toEqual(["repair", "validate", "readiness"]);
        expect(defaultRuntime.exit).toHaveBeenCalledExactlyOnceWith(0);
      } else {
        await expect(result).rejects.toBe(authority.error);
        expect(dispatched).toEqual([]);
        expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
      }
      expect((await readConfigFileSnapshot({ observe: false })).raw).toBe(before.raw);
    },
  );
});
