import "./doctor-health.test-support.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { tryAcquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import * as packageRoots from "../infra/openclaw-root.js";
import type { RetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { initialDoctorHealthContribution } from "./doctor-health-contributions-selection.test-support.js";
import { createDoctorRuntimeProjection } from "./doctor-health-contributions.test-support.js";
import { useDoctorHealthFixture } from "./doctor-health.fixture.test-support.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");

const custody = vi.hoisted(() => ({
  note: vi.fn(),
  census: vi.fn(),
  retireBroker: vi.fn<() => Promise<boolean>>(),
  activeNativeWork: false,
  activeWorkerPath: "",
  actualNativeSource: false,
}));

vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
  note: custody.note,
}));
vi.mock("../infra/openclaw-process-census.js", () => ({
  inspectOtherOpenClawProcesses: custody.census,
}));
vi.mock("../infra/worker-native-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/worker-native-lifecycle.js")>();
  const capture = actual.captureRetainedNativeWorkerSource;
  const sources = new WeakMap<RetainedNativeWorkerSource, RetainedNativeWorkerSource>();
  return {
    ...actual,
    captureRetainedNativeWorkerSource: (...args: Parameters<typeof capture>) => {
      const source = capture(...args);
      const captured = sources.get(source) ?? {
        ...source,
        retireIdleBroker: () =>
          custody.actualNativeSource ? source.retireIdleBroker() : custody.retireBroker(),
        activeWorkerPaths: () =>
          custody.actualNativeSource
            ? source.activeWorkerPaths()
            : custody.activeNativeWork
              ? [custody.activeWorkerPath]
              : [],
        get hasActiveWorkers() {
          return custody.actualNativeSource ? source.hasActiveWorkers : custody.activeNativeWork;
        },
      };
      sources.set(source, captured);
      return captured;
    },
  };
});

const { materializeSharedStateDatabase } = useDoctorHealthFixture();
afterEach(() => {
  vi.restoreAllMocks();
  custody.note.mockReset();
  custody.census.mockReset();
  custody.retireBroker.mockReset();
  custody.activeNativeWork = false;
  custody.actualNativeSource = false;
});

it.each([
  "idle",
  "idle-read-pool",
  "idle-plugin-preparation",
  "independent-owner",
  "independent-thread",
  "late-independent-thread",
  "settlement-failed",
] as const)(
  "reclaims retained runtimes before the stop, once Doctor-owned workers settle (%s broker)",
  async (broker) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const realNativeSource = broker === "idle-read-pool" || broker === "idle-plugin-preparation";
      custody.actualNativeSource = realNativeSource;
      materializeSharedStateDatabase(state.env);
      const root = fs.realpathSync(state.root);
      const packageRoot = path.join(root, "checkout");
      fs.mkdirSync(packageRoot);
      fs.writeFileSync(path.join(packageRoot, "package.json"), '{"name":"openclaw"}');
      mocks.packageRoot.mockReturnValue(packageRoot);
      const artifact = createDoctorRuntimeProjection(root, packageRoot, "Old001");
      custody.activeWorkerPath = path.join(artifact, "worker.js");
      vi.spyOn(os, "tmpdir").mockReturnValue(root);
      vi.spyOn(packageRoots, "resolveOpenClawPackageRootsSync").mockReturnValue([packageRoot]);
      mocks.service.mockReturnValue({
        readCommand: async () => null,
        readRuntime: async () => ({ status: "stopped", missingUnit: true }),
        isLoaded: async () => false,
      });

      const database = resolveOpenClawStateSqlitePath(state.env);
      const { captureRetainedNativeWorkerSource } =
        await import("../infra/worker-native-lifecycle.js");
      // Workers Doctor's own earlier reads left idle in this process.
      let readSource: RetainedNativeWorkerSource | undefined;
      if (broker === "idle-read-pool") {
        const { executeExistingOpenClawStateRead } =
          await import("../state/openclaw-state-db-readonly.js");
        await executeExistingOpenClawStateRead(
          { path: database, env: state.env },
          { type: "backup.runs" },
        );
        readSource = captureRetainedNativeWorkerSource();
        expect(readSource.hasActiveWorkers).toBe(true);
      }
      if (broker === "idle-plugin-preparation") {
        const { withPluginSourceCaptureStorage } =
          await import("../plugins/plugin-source-capture-context.js");
        const { preparePluginGenerationArtifact } =
          await import("../plugins/plugin-generation-worker.js");
        const pluginRoot = path.join(root, "plugin-source");
        const entry = path.join(pluginRoot, "index.js");
        fs.mkdirSync(pluginRoot);
        fs.writeFileSync(
          path.join(pluginRoot, "package.json"),
          '{"name":"fixture","type":"module"}',
        );
        fs.writeFileSync(entry, "export const value = 42;");
        // Setup module loaders retain this artifact for the command's plugin cache.
        await withPluginSourceCaptureStorage({ stateDir: root, placement: "temporary" }, () =>
          preparePluginGenerationArtifact({ rootDir: pluginRoot, source: entry }),
        );
        expect(captureRetainedNativeWorkerSource().hasActiveWorkers).toBe(true);
      }
      let brokerLive = broker !== "independent-thread" && !realNativeSource;
      let checksStarted = false;
      // Cleanup needs no stop: it runs before Doctor takes state custody, while another
      // owner (the serving Gateway) could still hold the state.
      const assertBeforeMaintenance = () => {
        expect(checksStarted).toBe(false);
        expect(getOpenClawDatabaseMaintenanceScope()).toBeUndefined();
        const competingOwner = tryAcquireGatewayStateOwner(database);
        expect(competingOwner).not.toBeNull();
        competingOwner?.release();
      };
      custody.retireBroker.mockImplementation(async () => {
        assertBeforeMaintenance();
        if (broker === "settlement-failed") {
          throw new Error("fixture broker could not settle native cleanup");
        }
        // Native lifecycle tests cover real shared owners and SQLite locks. Here
        // the census reflects their custody while exercising the complete Doctor flow.
        if (broker === "independent-owner" || broker === "independent-thread") {
          return false;
        }
        brokerLive = false;
        return true;
      });
      custody.census.mockImplementation(() => {
        assertBeforeMaintenance();
        custody.activeNativeWork =
          broker === "late-independent-thread" || broker === "independent-thread";
        return {
          pids: readSource
            ? readSource.hasActiveWorkers
              ? [42423]
              : []
            : brokerLive
              ? [42422]
              : [],
        };
      });
      let presentDuringChecks: boolean | undefined;
      mocks.runContributions.mockImplementation(async (ctx) => {
        checksStarted = true;
        // Under maintenance the diagnostic contribution leaves cleanup to the --fix pass.
        await initialDoctorHealthContribution("doctor:retained-update-runtimes").run(ctx);
        presentDuringChecks = fs.existsSync(artifact);
      });

      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
      // The stopped repairs ran in every case, including a failed cleanup.
      expect(checksStarted).toBe(true);
      const retained =
        broker !== "idle" && broker !== "idle-read-pool" && broker !== "idle-plugin-preparation";
      expect([presentDuringChecks, fs.existsSync(artifact)]).toEqual([retained, retained]);
      if (broker === "settlement-failed") {
        expect(custody.census).not.toHaveBeenCalled();
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("fixture broker could not settle native cleanup"),
        );
        return;
      }
      const output = custody.note.mock.calls.map(([message]) => String(message)).join("\n");
      expect(custody.census).toHaveBeenCalledOnce();
      if (retained) {
        expect(output).toContain(
          broker === "independent-owner"
            ? "PIDs: 42422"
            : `independent native work in this process (PID: ${process.pid})`,
        );
        if (broker === "independent-owner") {
          expect(brokerLive).toBe(true);
        }
        expect(output).toContain("let these holders finish, then rerun openclaw doctor --fix");
        expect(output).not.toContain("Removed abandoned updater runtime");
      } else {
        expect(output).toContain(`Removed abandoned updater runtime: ${artifact}`);
      }
    });
  },
);
