import "./doctor-health.test-support.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  resolveGatewayStateOwnerPath,
  tryAcquireGatewayStateOwner,
} from "../infra/gateway-state-owner.js";
import * as packageRoots from "../infra/openclaw-root.js";
import {
  readOnlyWorkerScope,
  type SqliteReadOnlyWorkerScope,
} from "../infra/sqlite-readonly-worker-context.js";
import type { RetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { initialDoctorHealthContribution } from "./doctor-health-contributions-selection.test-support.js";
import { createDoctorRuntimeProjection } from "./doctor-health-contributions.test-support.js";
import { useDoctorHealthFixture } from "./doctor-health.fixture.test-support.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");

const custody = vi.hoisted(() => ({
  note: vi.fn(),
  retireBroker: vi.fn<() => Promise<boolean>>(),
  activeNativeWork: false,
  activeWorkerPath: "",
  actualNativeSource: false,
}));

vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
  note: custody.note,
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
  "reclaims retained runtimes only after Doctor-owned readers settle (%s broker)",
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
      const ownerPath = resolveGatewayStateOwnerPath(database);
      let ownerIdentity: Buffer | undefined;
      let doctorReaders: SqliteReadOnlyWorkerScope | undefined;
      let readSource: RetainedNativeWorkerSource | undefined;
      let checksFinished = false;
      const assertMaintenanceHeld = () => {
        const competingOwner = tryAcquireGatewayStateOwner(database);
        competingOwner?.release();
        expect(competingOwner).toBeNull();
        expect(fs.readFileSync(ownerPath)).toEqual(ownerIdentity);
      };
      custody.retireBroker.mockImplementation(async () => {
        assertMaintenanceHeld();
        expect([checksFinished, doctorReaders?.active]).toEqual([true, false]);
        if (broker === "settlement-failed") {
          throw new Error("fixture broker could not settle native cleanup");
        }
        // Native work that starts after Doctor's readers settle must still retain the runtime.
        custody.activeNativeWork =
          broker === "late-independent-thread" || broker === "independent-thread";
        if (broker === "independent-owner" || broker === "independent-thread") {
          return false;
        }
        return true;
      });
      mocks.runContributions.mockImplementation(async (ctx) => {
        ownerIdentity = fs.readFileSync(ownerPath);
        doctorReaders = readOnlyWorkerScope.getStore();
        expect(doctorReaders?.active).toBe(true);
        if (broker === "idle-read-pool") {
          const { executeExistingOpenClawStateRead } =
            await import("../state/openclaw-state-db-readonly.js");
          const { captureRetainedNativeWorkerSource } =
            await import("../infra/worker-native-lifecycle.js");
          await executeExistingOpenClawStateRead(
            { path: database, env: state.env },
            { type: "backup.runs" },
          );
          readSource = captureRetainedNativeWorkerSource();
          expect(readSource.hasActiveWorkers).toBe(true);
        }
        if (broker === "idle-plugin-preparation") {
          const { captureRetainedNativeWorkerSource } =
            await import("../infra/worker-native-lifecycle.js");
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
        await initialDoctorHealthContribution("doctor:retained-update-runtimes").run(ctx);
        expect(fs.existsSync(artifact)).toBe(true);
        checksFinished = true;
      });

      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const completed = runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
      if (broker === "settlement-failed") {
        await expect(completed).rejects.toThrow("fixture broker could not settle native cleanup");
        expect(fs.existsSync(artifact)).toBe(true);
        return;
      }
      await completed;
      const output = custody.note.mock.calls.map(([message]) => String(message)).join("\n");
      // Only native work in this process retains the runtime; another process's broker
      // does not, because no process census decides custody.
      const retained = broker === "independent-thread" || broker === "late-independent-thread";
      expect(fs.existsSync(artifact)).toBe(retained);
      if (retained) {
        expect(output).toContain(`independent native work in this process (PID: ${process.pid})`);
        expect(output).toContain("let these holders finish, then rerun openclaw doctor --fix");
        expect(output).not.toContain("Removed abandoned updater runtime");
      } else {
        expect(output).toContain(`Removed abandoned updater runtime: ${artifact}`);
      }
    });
  },
);
