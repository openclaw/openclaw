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
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runRetainedUpdateRuntimesHealth } from "./doctor-health-contribution-runners.state.js";
import { useDoctorHealthFixture } from "./doctor-health.fixture.test-support.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");

const custody = vi.hoisted(() => ({
  note: vi.fn(),
  census: vi.fn(),
  retireBroker: vi.fn<() => Promise<boolean>>(),
  activeNativeWork: false,
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
  return {
    ...actual,
    captureRetainedNativeWorkerSource: (
      ...args: Parameters<typeof actual.captureRetainedNativeWorkerSource>
    ) => ({
      ...actual.captureRetainedNativeWorkerSource(...args),
      retireIdleBroker: custody.retireBroker,
      get hasActiveWorkers() {
        return custody.activeNativeWork;
      },
    }),
  };
});

const { materializeSharedStateDatabase } = useDoctorHealthFixture();
afterEach(() => {
  vi.restoreAllMocks();
  custody.note.mockReset();
  custody.census.mockReset();
  custody.retireBroker.mockReset();
  custody.activeNativeWork = false;
});

it.each([
  "idle",
  "independent-owner",
  "independent-thread",
  "late-independent-thread",
  "settlement-failed",
] as const)(
  "reclaims retained runtimes only after Doctor-owned readers settle (%s broker)",
  async (broker) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      materializeSharedStateDatabase(state.env);
      const root = fs.realpathSync(state.root);
      const packageRoot = path.join(root, "checkout");
      const artifact = path.join(root, "openclaw-update-runtime-Old001");
      const base = path.parse(packageRoot).root;
      const marker = path.join(
        artifact,
        "tree",
        Buffer.from(base).toString("hex"),
        path.relative(base, packageRoot),
        "package.json",
      );
      fs.mkdirSync(packageRoot);
      fs.writeFileSync(path.join(packageRoot, "package.json"), '{"name":"openclaw"}');
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, '{"name":"openclaw"}');
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
      let brokerLive = false;
      let checksFinished = false;
      const assertMaintenanceHeld = () => {
        const competingOwner = tryAcquireGatewayStateOwner(database);
        competingOwner?.release();
        expect(competingOwner).toBeNull();
        expect(fs.readFileSync(ownerPath)).toEqual(ownerIdentity);
      };
      custody.retireBroker.mockImplementation(async () => {
        assertMaintenanceHeld();
        expect(checksFinished).toBe(true);
        expect(doctorReaders?.active).toBe(false);
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
        assertMaintenanceHeld();
        const maintenance = getOpenClawDatabaseMaintenanceScope();
        expect(maintenance?.ownsSchemaMaintenance).toBe(true);
        maintenance!.assertAdmission();
        custody.activeNativeWork = broker === "late-independent-thread";
        return {
          pids: [...(doctorReaders?.active ? [42421] : []), ...(brokerLive ? [42422] : [])],
        };
      });
      mocks.runContributions.mockImplementation(async (ctx) => {
        ownerIdentity = fs.readFileSync(ownerPath);
        doctorReaders = readOnlyWorkerScope.getStore();
        expect(doctorReaders?.active).toBe(true);
        brokerLive = broker !== "independent-thread";
        await runRetainedUpdateRuntimesHealth(ctx);
        expect(fs.existsSync(artifact)).toBe(true);
        checksFinished = true;
      });

      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const completed = runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
      if (broker === "settlement-failed") {
        await expect(completed).rejects.toThrow("fixture broker could not settle native cleanup");
        expect(custody.census).not.toHaveBeenCalled();
        expect(fs.existsSync(artifact)).toBe(true);
        return;
      }
      await completed;
      const output = custody.note.mock.calls.map(([message]) => String(message)).join("\n");
      expect(custody.census).toHaveBeenCalledOnce();
      expect(fs.existsSync(artifact)).toBe(broker !== "idle");
      if (broker === "independent-owner") {
        expect(brokerLive).toBe(true);
        expect(output).toContain("PIDs: 42422");
        expect(output).toContain("let these holders finish, then rerun openclaw doctor --fix");
        expect(output).not.toContain("Removed abandoned updater runtime");
      } else if (broker === "independent-thread" || broker === "late-independent-thread") {
        expect(output).toContain(`independent native work in this process (PID: ${process.pid})`);
        expect(output).toContain("let these holders finish, then rerun openclaw doctor --fix");
        expect(output).not.toContain("Removed abandoned updater runtime");
      } else {
        expect(output).toContain(`Removed abandoned updater runtime: ${artifact}`);
      }
    });
  },
);
