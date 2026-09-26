import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import { readGitRuntimeArtifactIdentity } from "../../infra/update-git-runtime.js";
import { updateRunStepsFromResultStep } from "../../infra/update-run-step.js";
import * as pluginRecords from "../../plugins/installed-plugin-index-records.js";
import * as pluginLifecycle from "../../plugins/plugin-lifecycle-lease.js";
import { VERSION } from "../../version.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  resolveEntrypoint: vi.fn(),
  runExec: vi.fn(),
  convergeCandidate: vi.fn(),
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfig,
}));
vi.mock("../../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.resolveEntrypoint,
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
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  readPackageVersion: vi.fn(async () => "2026.9.4"),
  resolveNodeRunner: vi.fn(() => "/usr/bin/node"),
}));
vi.mock("./update-command-resume.js", () => ({
  convergePostCoreUpdatePlugins: mocks.convergeCandidate,
}));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: vi.fn(), log: vi.fn() },
}));

import * as shared from "./shared.js";
import * as pluginConfig from "./update-command-config.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import * as plugins from "./update-command-plugins.js";
import * as postCore from "./update-command-post-core.js";
import * as sourceRuntime from "./update-command-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const snapshot: ConfigFileSnapshot = {
  path: "/isolated/openclaw.json",
  exists: true,
  raw: "{}",
  valid: true,
  parsed: {},
  sourceConfig: {},
  resolved: {},
  runtimeConfig: {},
  config: {},
  warnings: [],
  issues: [],
  legacyIssues: [],
};
const pluginUpdate: PostCorePluginUpdateResult = {
  status: "ok",
  changed: true,
  sync: {
    changed: false,
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
  warnings: [],
};

beforeEach(() => {
  vi.mocked(shared.readPackageVersion).mockResolvedValue("2026.9.4");
  mocks.readConfig.mockReset().mockResolvedValue(snapshot);
  mocks.resolveEntrypoint.mockReset().mockResolvedValue("/isolated/dist/index.js");
  mocks.convergeCandidate.mockReset().mockResolvedValue({ pluginUpdate, configSnapshot: snapshot });
  mocks.runExec.mockReset().mockImplementation(async (_command, args: string[]) => ({
    stdout: args.includes("--lint")
      ? JSON.stringify({ ok: true, checksRun: 1, checksSkipped: 0, findings: [] })
      : "",
    stderr: "",
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("candidate convergence Doctor dispatch authority", () => {
  it.each(
    [false, true].flatMap((candidateRuntime) =>
      ["unchanged", "changed-before", "changed-during"].map((scenario) => ({
        candidateRuntime,
        scenario,
      })),
    ),
  )(
    "compares the activated Git fact after convergence ($scenario, candidate=$candidateRuntime)",
    async ({ candidateRuntime, scenario }) => {
      const root = tempDirs.make("openclaw-git-verification-");
      const dist = path.join(root, "dist");
      const writer = path.join(dist, "io.write-fixture.mjs");
      const entry = path.join(dist, "entry.mjs");
      const executed = path.join(root, "executed");
      await fs.mkdir(dist);
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: VERSION }));
      await fs.writeFile(
        path.join(dist, "build-info.json"),
        JSON.stringify({ commit: "same-commit" }),
      );
      await fs.writeFile(writer, "export const generation = 1;\n");
      await fs.writeFile(
        entry,
        `import fs from "node:fs/promises";
await fs.writeFile(${JSON.stringify(executed)}, String(process.pid));
${scenario === "changed-during" ? `await fs.writeFile(${JSON.stringify(writer)}, "export const generation = 2;\\n");` : ""}
await fs.writeFile(process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH, ${JSON.stringify(JSON.stringify({ ...pluginUpdate, changed: false }))});
`,
      );
      const activated = await readGitRuntimeArtifactIdentity(root);
      if (scenario === "changed-before") {
        await fs.writeFile(writer, "export const generation = 2;\n");
      }
      mocks.resolveEntrypoint.mockResolvedValue(entry);
      vi.mocked(shared.readPackageVersion).mockResolvedValue(VERSION);
      if (candidateRuntime) {
        vi.spyOn(sourceRuntime, "completeSourceUpdateRuntime").mockResolvedValue({
          changed: false,
        });
        mocks.convergeCandidate.mockImplementation(async () => {
          if (scenario === "changed-during") {
            await fs.writeFile(writer, "export const generation = 2;\n");
          }
          return { pluginUpdate: { ...pluginUpdate, changed: false }, configSnapshot: snapshot };
        });
      }
      const { resultWithPostUpdate: result } = await convergeUpdatePlugins({
        candidateRuntime,
        result: {
          status: "ok",
          mode: "git",
          root,
          before: { sha: "same-commit", version: VERSION },
          after: { sha: "same-commit", version: VERSION },
          gitRuntime: activated,
          steps: [],
          durationMs: 0,
        },
        root,
        installKindChanged: false,
        configSnapshot: snapshot,
        requestedChannel: null,
        storedChannel: null,
        channel: "dev",
        downgradeRisk: false,
        opts: { json: true, yes: true },
        preUpdatePluginInstallRecords: {},
        startedAt: Date.now(),
        updateStepTimeoutMs: 5000,
        packageUpdateNodeRunner: process.execPath,
      });
      if (candidateRuntime) {
        await expect(fs.stat(executed)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(Number(await fs.readFile(executed, "utf8"))).not.toBe(process.pid);
      }
      expect(result.status).toBe(scenario === "unchanged" ? "ok" : "error");
      const verification = result.steps.find(
        (step) => step.name === "post-core runtime verification",
      )!;
      const receipts = updateRunStepsFromResultStep(verification);
      expect(receipts[0]?.status).toBe(scenario === "unchanged" ? "completed" : "failed");
      const facts = JSON.parse(
        receipts.find((receipt) => receipt.step.startsWith("diagnostic:"))!.detail!,
      );
      expect(facts.activated).toEqual(activated);
      expect(facts.observed.commit).toBe("same-commit");
      expect(facts.observed.distDigest === activated.distDigest).toBe(scenario === "unchanged");
      if (scenario !== "unchanged") {
        expect(verification.failureFacts).toContainEqual(
          expect.objectContaining({ code: "runtime-verification-failed" }),
        );
      }
    },
  );

  it.each(
    (["npm", "git", "git-rebuilt"] as const).flatMap((runtime) =>
      [false, true].map((revoked) => ({ runtime, revoked })),
    ),
  )(
    "lets the installed $runtime target own convergence before parent worker use (revoked=$revoked)",
    async ({ runtime, revoked }) => {
      const rebuilt = runtime === "git-rebuilt";
      const version = rebuilt ? VERSION : "2026.9.4";
      vi.mocked(shared.readPackageVersion).mockResolvedValue(version);
      const incompatibleWorker = new Error("Unknown shared-state SQLite command");
      const parentLease = vi
        .spyOn(pluginLifecycle, "withPluginLifecycleLease")
        .mockRejectedValue(incompatibleWorker);
      const parentRuntime = vi.spyOn(sourceRuntime, "completeSourceUpdateRuntime");
      let current = true;
      const authorityRefusal = new Error("Update requester revoked after target convergence");
      const delegate = vi
        .spyOn(postCore, "continuePostCoreUpdateInFreshProcess")
        .mockImplementationOnce(async ({ root, channel }) => {
          expect(root).toBe("/isolated");
          expect(channel).toBe("stable");
          current = !revoked;
          return { resumed: true, pluginUpdate: { ...pluginUpdate, changed: false } };
        });
      const outcome = convergeUpdatePlugins({
        result: {
          status: "ok",
          mode: runtime === "npm" ? "npm" : "git",
          root: "/isolated",
          before: { version: VERSION, sha: "old-checkout", buildId: "updater-build" },
          after: {
            version,
            sha: rebuilt ? "old-checkout" : "target-checkout",
            buildId: "published-build",
          },
          steps: [],
          durationMs: 0,
        },
        root: "/isolated",
        installKindChanged: false,
        configSnapshot: snapshot,
        requestedChannel: null,
        storedChannel: null,
        channel: "stable",
        downgradeRisk: true,
        opts: { json: true, yes: true },
        preUpdatePluginInstallRecords: {},
        startedAt: Date.now(),
        updateStepTimeoutMs: 5_000,
        assertCurrent: () => {
          if (!current) {
            throw authorityRefusal;
          }
        },
      });
      if (revoked) {
        await expect(outcome).rejects.toBe(authorityRefusal);
        expect(mocks.runExec).not.toHaveBeenCalled();
      } else {
        const result = await outcome;
        expect(result.resultWithPostUpdate).toMatchObject({
          status: "ok",
          postUpdate: { plugins: { status: "ok" } },
        });
        expect(result.resultWithPostUpdate.steps).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "source runtime publication" })]),
        );
      }
      expect(delegate).toHaveBeenCalledOnce();
      expect(parentLease).not.toHaveBeenCalled();
      expect(parentRuntime).not.toHaveBeenCalled();
      expect(mocks.convergeCandidate).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "preserves source-completion ownership when consent handoff is declined (retained different runtime=%s)",
    async (retainedDifferentRuntime) => {
      vi.mocked(shared.readPackageVersion).mockResolvedValue(
        retainedDifferentRuntime ? "2026.9.4" : VERSION,
      );
      const events: string[] = [];
      mocks.runExec.mockImplementation(async (_command, args: string[]) => {
        if (args.includes("--help")) {
          events.push("target-declined-consent");
          return { stdout: "Usage: openclaw update [--yes]", stderr: "" };
        }
        return {
          stdout: args.includes("--lint")
            ? JSON.stringify({ ok: true, checksRun: 1, checksSkipped: 0, findings: [] })
            : "",
          stderr: "",
        };
      });
      // Exercise the real target capability refusal, including its resumed:false outcome.
      const delegate = vi.spyOn(postCore, "continuePostCoreUpdateInFreshProcess");
      const runtime = vi
        .spyOn(sourceRuntime, "completeSourceUpdateRuntime")
        .mockImplementation(async ({ lease }) => {
          lease.assertOwned();
          events.push("source-published");
          return { changed: true };
        });
      vi.spyOn(pluginConfig, "preparePostCorePluginConfig").mockResolvedValue({
        configSnapshot: snapshot,
        configWriteOptions: {},
        configChanged: false,
        restoredAuthoredChannels: [],
      });
      vi.spyOn(pluginRecords, "loadInstalledPluginIndexInstallRecords").mockResolvedValue({});
      const localPlugins = vi
        .spyOn(plugins, "updatePluginsAfterCoreUpdate")
        .mockImplementation(async () => {
          events.push("local-plugins");
          return { ...pluginUpdate, changed: false, assessment: { kind: "no-payload-repair" } };
        });
      const actualResume = await vi.importActual<typeof import("./update-command-resume.js")>(
        "./update-command-resume.js",
      );
      mocks.convergeCandidate.mockImplementation(actualResume.convergePostCoreUpdatePlugins);
      const result = await convergeUpdatePlugins({
        coreAlreadyCurrent: retainedDifferentRuntime,
        result: {
          status: retainedDifferentRuntime ? "skipped" : "ok",
          ...(retainedDifferentRuntime ? { reason: "already-current" } : {}),
          mode: "git",
          root: "/isolated",
          before: { version: VERSION, sha: "old-checkout" },
          after: {
            version: retainedDifferentRuntime ? "2026.9.4" : VERSION,
            sha: "target-checkout",
          },
          steps: [],
          durationMs: 0,
        },
        root: "/isolated",
        installKindChanged: false,
        configSnapshot: snapshot,
        requestedChannel: null,
        storedChannel: null,
        channel: "stable",
        downgradeRisk: retainedDifferentRuntime,
        opts: { json: true, yes: true, acceptCapabilities: true },
        preUpdatePluginInstallRecords: {},
        startedAt: Date.now(),
        updateStepTimeoutMs: 5_000,
      });
      expect(delegate).toHaveBeenCalledOnce();
      await expect(delegate.mock.results[0]?.value).resolves.toMatchObject({ resumed: false });
      expect(mocks.convergeCandidate).toHaveBeenCalledTimes(retainedDifferentRuntime ? 0 : 1);
      if (retainedDifferentRuntime) {
        expect(result.resultWithPostUpdate).toMatchObject({
          status: "error",
          reason: "post-core-update-failed",
        });
        expect(result.detail).toContain("installed target executable");
        expect(events).toEqual(["target-declined-consent"]);
        expect(runtime).not.toHaveBeenCalled();
        expect(localPlugins).not.toHaveBeenCalled();
      } else {
        expect(result.resultWithPostUpdate.status).toBe("ok");
        expect(events).toEqual(["target-declined-consent", "source-published", "local-plugins"]);
        expect(runtime).toHaveBeenCalledOnce();
        expect(result.resultWithPostUpdate.steps).toContainEqual(
          expect.objectContaining({ name: "source runtime publication", exitCode: 0 }),
        );
      }
    },
  );

  it.each(["runtime", "plugins"] as const)(
    "parks before %s changes while converging in the candidate runtime",
    async (changed) => {
      vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", "0.0.1");
      const events: string[] = [];
      const park = vi.fn(async () => {
        events.push("park");
      });
      const assertCurrent = vi.fn();
      const runtime = vi
        .spyOn(sourceRuntime, "completeSourceUpdateRuntime")
        .mockImplementation(async (params) => {
          expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("2026.9.4");
          if (changed === "runtime") {
            await params.beforePublication?.();
            await params.beforePersistentEffect?.();
            events.push("publish");
          }
          return { changed: changed === "runtime" };
        });
      const delegate = vi
        .spyOn(postCore, "continuePostCoreUpdateInFreshProcess")
        .mockImplementation(async () => {
          throw new Error("Candidate runtime must not delegate convergence again");
        });
      mocks.convergeCandidate.mockImplementation(async (params) => {
        expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("2026.9.4");
        params.assertCurrent();
        events.push("candidate-plugins");
        return {
          pluginUpdate: { ...pluginUpdate, changed: changed === "plugins" },
          configSnapshot: snapshot,
        };
      });
      try {
        const result = await convergeUpdatePlugins({
          candidateRuntime: true,
          coreAlreadyCurrent: true,
          result: {
            status: "skipped",
            reason: "already-current",
            mode: "git",
            root: "/isolated",
            steps: [],
            durationMs: 0,
          },
          root: "/isolated",
          installKindChanged: false,
          configSnapshot: snapshot,
          requestedChannel: null,
          storedChannel: null,
          channel: "stable",
          downgradeRisk: false,
          opts: { json: true, yes: true },
          preUpdatePluginInstallRecords: {},
          startedAt: Date.now(),
          updateStepTimeoutMs: 5_000,
          packageUpdateNodeRunner: "/selected/node",
          beforeRuntimePublication: park,
          beforeDoctor: park,
          assertCurrent,
        });
        expect(runtime).toHaveBeenCalledOnce();
        expect(mocks.convergeCandidate).toHaveBeenCalledOnce();
        expect(delegate).not.toHaveBeenCalled();
        expect(park).toHaveBeenCalledOnce();
        expect(events).toEqual(
          changed === "runtime"
            ? ["park", "publish", "candidate-plugins"]
            : ["candidate-plugins", "park"],
        );
        expect(result.resultWithPostUpdate.status).toBe("ok");
        expect(result.resultWithPostUpdate.steps).toEqual(
          changed === "runtime"
            ? [expect.objectContaining({ name: "source runtime publication", exitCode: 0 })]
            : [],
        );
        if (changed === "plugins") {
          expect(mocks.runExec).toHaveBeenCalled();
          expect(mocks.runExec.mock.calls.every(([command]) => command === "/selected/node")).toBe(
            true,
          );
        }
        expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("0.0.1");
      } finally {
        runtime.mockRestore();
        delegate.mockRestore();
      }
    },
  );

  it.each([
    "live",
    "entrypoint-revocation",
    "maintenance-replacement",
    "doctor-revocation",
    "config-read-revocation",
    "validation-replacement",
    "entrypoint-first-refusal",
    "maintenance-first-refusal",
    "maintenance-deferred",
    "maintenance-at-risk",
  ] as const)("does not dispatch fresh Doctor with stale authority after %s", async (boundary) => {
    const originalOwner = {};
    let currentOwner: object | undefined = originalOwner;
    const stale = new Error("original updater is no longer current");
    const maintenanceRefusal = new DoctorMaintenanceRefusalError(
      "Doctor could not enter maintenance; run openclaw doctor --fix after the current owner stops.",
      boundary === "maintenance-at-risk"
        ? { kind: "data-at-risk", reason: "incomplete-migration" }
        : { kind: "deferred", reason: "coordinator-contention" },
    );
    let refusalArmed = false;
    let refusedOnce = false;
    const assertCurrent = () => {
      if (refusalArmed && !refusedOnce) {
        refusedOnce = true;
        throw stale;
      }
      if (currentOwner !== originalOwner) {
        throw stale;
      }
    };
    if (boundary === "entrypoint-revocation" || boundary === "entrypoint-first-refusal") {
      mocks.resolveEntrypoint.mockImplementationOnce(async () => {
        await Promise.resolve();
        if (boundary === "entrypoint-first-refusal") {
          refusalArmed = true;
        } else {
          currentOwner = undefined;
        }
        return "/isolated/dist/index.js";
      });
    }
    const dispatched: string[] = [];
    mocks.runExec.mockImplementation(async (_command, args: string[]) => {
      const operation = args.includes("--repair")
        ? "repair"
        : args.includes("--lint")
          ? "readiness"
          : "validate";
      dispatched.push(operation);
      await Promise.resolve();
      if (boundary === "doctor-revocation" && operation === "repair") {
        currentOwner = undefined;
      }
      if (boundary === "validation-replacement" && operation === "validate") {
        currentOwner = {};
      }
      return {
        stdout:
          operation === "readiness"
            ? JSON.stringify({ ok: true, checksRun: 1, checksSkipped: 0, findings: [] })
            : "",
        stderr: "",
      };
    });
    if (boundary === "config-read-revocation") {
      mocks.readConfig.mockImplementationOnce(async () => {
        await Promise.resolve();
        currentOwner = undefined;
        return snapshot;
      });
    }
    const outcome = convergeUpdatePlugins({
      candidateRuntime: true,
      result: { status: "ok", mode: "npm", root: "/isolated", steps: [], durationMs: 0 },
      root: "/isolated",
      installKindChanged: false,
      configSnapshot: snapshot,
      requestedChannel: null,
      storedChannel: null,
      channel: "stable",
      downgradeRisk: false,
      opts: { json: true, yes: true },
      preUpdatePluginInstallRecords: {},
      startedAt: Date.now(),
      updateStepTimeoutMs: 5_000,
      assertCurrent,
      beforeDoctor: async () => {
        await Promise.resolve();
        if (boundary === "maintenance-deferred" || boundary === "maintenance-at-risk") {
          throw maintenanceRefusal;
        }
        if (boundary === "maintenance-first-refusal") {
          refusalArmed = true;
        }
        if (boundary === "maintenance-replacement") {
          currentOwner = {};
        }
      },
    });
    if (boundary === "maintenance-deferred") {
      const completed = await outcome;
      expect(completed.resultWithPostUpdate).toMatchObject({
        status: "ok",
        postUpdate: { plugins: { status: "warning", changed: true } },
        steps: [
          expect.objectContaining({
            exitCode: 0,
            advisory: { kind: "package-post-install-doctor", message: maintenanceRefusal.message },
          }),
        ],
      });
      expect(dispatched).toEqual([]);
      expect(mocks.readConfig).not.toHaveBeenCalled();
    } else if (boundary === "maintenance-at-risk") {
      await expect(outcome).rejects.toBe(maintenanceRefusal);
      expect(dispatched).toEqual([]);
    } else if (boundary === "live") {
      expect((await outcome).resultWithPostUpdate.status).toBe("ok");
      expect(dispatched).toEqual(["repair", "validate", "readiness"]);
    } else {
      await expect(outcome).rejects.toBe(stale);
      // The terminal caller check is too late if the mutating child was dispatched.
      const allowed =
        boundary === "validation-replacement"
          ? ["repair", "validate"]
          : boundary === "doctor-revocation" || boundary === "config-read-revocation"
            ? ["repair"]
            : [];
      expect(dispatched).toEqual(allowed);
    }
  });
});
