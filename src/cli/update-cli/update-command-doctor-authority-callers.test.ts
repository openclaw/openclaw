import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import { createUpdateRun, recordUpdateRunStep } from "../../infra/update-run-ledger.js";
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
