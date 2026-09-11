import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readScheduledTaskRuntime } from "../../daemon/schtasks-runtime.js";
import { readGatewayServiceState, type GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  revalidateManagedGatewayServiceAfterUpdate,
  type PreManagedServiceStop,
} from "./update-command-service-maintenance.js";

const mocks = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  taskState: 3 as number | string,
}));

vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(() => ({
    pid: 0,
    output: [null, JSON.stringify({ state: mocks.taskState, lastRunResult: 0 }), ""],
    stdout: JSON.stringify({ state: mocks.taskState, lastRunResult: 0 }),
    stderr: "",
    status: 0,
    signal: null,
  })),
}));

beforeEach(() => mockSystemAccountHome());
afterEach(() => vi.restoreAllMocks());

async function withServiceHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await makeTempWorkspace("openclaw-update-service-");
  vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(home);
  try {
    await withEnvAsync(
      {
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, "AppData"),
        OPENCLAW_GATEWAY_PORT: undefined,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
      },
      () => run(home),
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

type NativeOfflineCase = {
  platform: NodeJS.Platform;
  label: string;
  runtime: "running" | "stopped" | "unknown";
  loaded: boolean;
  offline: boolean;
  enabled?: boolean;
  phase?: "inspect" | "prepare";
  state?: number | string;
};

const nativeOfflineCases: NativeOfflineCase[] = [
  {
    platform: "linux",
    label: "terminal inactive",
    runtime: "stopped",
    loaded: true,
    offline: true,
  },
  {
    platform: "linux",
    label: "restart transition",
    runtime: "unknown",
    loaded: true,
    offline: false,
  },
  { platform: "linux", label: "running", runtime: "running", loaded: true, offline: false },
  { platform: "darwin", label: "unloaded", runtime: "stopped", loaded: false, offline: true },
  {
    platform: "darwin",
    label: "loaded enabled",
    runtime: "stopped",
    loaded: true,
    enabled: true,
    offline: false,
  },
  {
    platform: "darwin",
    label: "loaded disabled",
    runtime: "stopped",
    loaded: true,
    enabled: false,
    offline: true,
  },
  {
    platform: "darwin",
    label: "loaded disabled preparation",
    runtime: "stopped",
    loaded: true,
    enabled: false,
    offline: true,
    phase: "prepare",
  },
  {
    platform: "darwin",
    label: "enabled unknown",
    runtime: "stopped",
    loaded: true,
    offline: false,
  },
  ...[
    { label: "disabled", state: 1, offline: true },
    { label: "ready", state: 3, offline: true },
    { label: "queued", state: 2, offline: false },
    { label: "running", state: 4, offline: false },
    { label: "unknown", state: 0, offline: false },
    { label: "malformed", state: "3 trailing output", offline: false },
  ].map<NativeOfflineCase>((task) => ({
    platform: "win32",
    runtime:
      task.state === 1 || task.state === 3 ? "stopped" : task.state === 4 ? "running" : "unknown",
    loaded: true,
    label: task.label,
    state: task.state,
    offline: task.offline,
  })),
];

it.each(nativeOfflineCases)(
  "requires affirmative native offline proof for owned $platform service ($label)",
  (scenario) =>
    withServiceHome(async (home) => {
      mockProcessPlatform(scenario.platform);
      mocks.taskState = scenario.state ?? 3;
      const isEnabled = vi.fn<NonNullable<GatewayService["isEnabled"]>>(async () => {
        if (scenario.enabled === undefined) {
          throw new Error("enabled state unavailable");
        }
        return scenario.enabled;
      });
      const service = createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        }),
        readRuntime:
          scenario.platform === "win32"
            ? readScheduledTaskRuntime
            : async () => ({
                status: scenario.runtime,
                ...(scenario.platform === "linux" ? { systemd: { managerUid: 2001 } } : {}),
              }),
        isLoaded: async () => scenario.loaded,
        isEnabled,
      });
      mocks.service.mockReturnValue(service);
      const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
        root: process.cwd(),
        updateInstallKind: "package",
        shouldRestart: true,
        phase: scenario.phase ?? "inspect",
        jsonMode: true,
        timeoutMs: 200,
      });
      expect(inspected.serviceUpdateVerdict?.kind).toBe(
        scenario.runtime === "unknown" ? "unavailable" : "owned",
      );
      expect(inspected.offline).toBe(scenario.offline);
      for (const [args] of isEnabled.mock.calls) {
        expect(args.timeoutMs).toBe(200);
      }
      expect(service.stop).not.toHaveBeenCalled();
      expect(service.start).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
      expect(service.stage).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
    }),
);

it.each([
  { code: "ETIMEDOUT", failures: 1, proceeds: true },
  { code: "ETIMEDOUT", failures: 2, proceeds: false },
  { code: "ETIMEDOUT", failures: 2, proceeds: false, admitted: true },
  { code: "ENOENT", failures: 1, proceeds: false },
])("handles Scheduled Task probe failures before update: %j", (scenario) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("win32");
    mocks.taskState = 4;
    vi.mocked(spawnSync).mockReset();
    for (let attempt = 0; attempt < scenario.failures; attempt++) {
      vi.mocked(spawnSync).mockReturnValueOnce({
        pid: 0,
        output: [null, "", ""],
        stdout: "",
        stderr: "",
        status: null,
        signal: null,
        error: Object.assign(new Error(`spawnSync powershell.exe ${scenario.code}`), {
          code: scenario.code,
        }),
      });
    }
    const service = createMockGatewayService({
      readCommand: vi.fn(async () => ({
        programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
        environment: { HOME: home },
      })),
      readRuntime: readScheduledTaskRuntime,
      isLoaded: async () => true,
    });
    mocks.service.mockReturnValue(service);

    const inspection = maybeStopManagedServiceBeforeMutableUpdate({
      root: process.cwd(),
      updateInstallKind: "package",
      shouldRestart: true,
      phase: "inspect",
      jsonMode: true,
      timeoutMs: 30_000,
      expectedService: scenario.admitted
        ? {
            serviceUpdateVerdict: {
              kind: "owned",
              root: process.cwd(),
              fingerprint: "admitted-definition",
              refreshDefinition: true,
            },
          }
        : undefined,
    });

    if (scenario.admitted) {
      await expect(inspection).rejects.toThrow("Scheduled Task probe timed out after 30000 ms");
    } else {
      const inspected = await inspection;
      if (scenario.proceeds) {
        expect(inspected.serviceUpdateVerdict?.kind).toBe("owned");
        expect(inspected.blockMessage).toBeUndefined();
        expect(inspected.running).toBe(true);
      } else {
        expect(inspected.serviceUpdateVerdict?.kind).toBe("unavailable");
        expect(inspected.blockMessage).toContain("Refusing to mutate code");
        if (scenario.code === "ETIMEDOUT") {
          expect(inspected.blockMessage).toContain("Scheduled Task probe timed out after 30000 ms");
          expect(inspected.blockMessage).toContain("ETIMEDOUT");
        }
      }
    }
    const attempts = scenario.code === "ETIMEDOUT" ? 2 : 1;
    expect(spawnSync).toHaveBeenCalledTimes(attempts);
    expect(service.readCommand).toHaveBeenCalledTimes(attempts);
    for (const call of vi.mocked(spawnSync).mock.calls) {
      expect(call[2]?.timeout).toBe(30_000);
    }
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  }),
);

const servingAncestorMaintenanceCases = [
  { platform: "linux", identity: "current updater", phase: "inspect", authorized: true },
  { platform: "linux", identity: "current updater", phase: "prepare", authorized: true },
  { platform: "darwin", identity: "current updater", phase: "inspect", authorized: true },
  { platform: "darwin", identity: "current updater", phase: "prepare", authorized: false },
  { platform: "linux", identity: "missing marker", phase: "prepare", authorized: false },
  { platform: "linux", identity: "missing metadata", phase: "prepare", authorized: false },
  { platform: "linux", identity: "missing lease", phase: "prepare", authorized: false },
  { platform: "linux", identity: "replaced owner", phase: "prepare", authorized: false },
  { platform: "linux", identity: "different root", phase: "prepare", authorized: false },
  { platform: "linux", identity: "different run", phase: "prepare", authorized: false },
  { platform: "linux", identity: "stale start identity", phase: "prepare", authorized: false },
  { platform: "linux", identity: "parent lease", phase: "prepare", authorized: false },
] as const;

it.runIf(process.platform === "linux" || process.platform === "darwin").each(
  servingAncestorMaintenanceCases.filter(
    // Binding a foreign PID reads native process identity, so only exercise that
    // fixture where the simulated Linux policy matches the actual host.
    ({ identity }) => identity !== "parent lease" || process.platform === "linux",
  ),
)(
  "keeps $platform serving-ancestor maintenance bound to the current updater: $identity $phase",
  ({ platform, identity, phase, authorized }) =>
    withServiceHome(async (home) => {
      mockProcessPlatform(platform);
      const root = await fs.realpath(process.cwd());
      const metaPath = path.join(home, "handoff-meta.json");
      const runId = randomUUID();
      vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(home);
      createUpdateRun({ runId, trigger: "cli" }, { env: process.env });
      await fs.writeFile(
        metaPath,
        JSON.stringify({
          version: 1,
          meta: {
            root: identity === "different root" ? home : root,
            runId: identity === "different run" ? randomUUID() : runId,
            handoffId: "owned-handoff",
          },
        }),
      );
      const store = createManagedHandoffLeaseStore();
      if (identity !== "missing lease") {
        const claim = store.acquire(
          root,
          identity === "replaced owner" ? "replacement-handoff" : "owned-handoff",
          { kind: "update" },
        );
        if (claim.kind !== "acquired") {
          throw new Error("fixture could not acquire its installation lease");
        }
        if (identity === "parent lease") {
          expect(store.bind(claim.lease, process.ppid)).not.toBeNull();
        } else if (identity === "stale start identity") {
          const db = openNodeSqliteDatabase(path.join(home, "managed-update-handoffs.sqlite"));
          try {
            db.prepare(
              "UPDATE managed_update_handoffs SET payload_json = json_set(payload_json, '$.executor.startIdentity', 'stale') WHERE install_root = ?",
            ).run(root);
          } finally {
            db.close();
          }
        }
      }
      await withEnvAsync(
        {
          OPENCLAW_UPDATE_RUN_HANDOFF: identity === "missing marker" ? undefined : "1",
          [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]:
            identity === "missing metadata" ? undefined : metaPath,
        },
        async () => {
          const service = createMockGatewayService({
            readCommand: async () => ({
              programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
              environment: { HOME: home },
            }),
            readRuntime: async () => ({
              status: "running",
              pid: process.ppid,
              systemd: { managerUid: 2001 },
            }),
            isLoaded: async () => true,
          });
          mocks.service.mockReturnValue(service);
          const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
            root,
            updateInstallKind: "package",
            shouldRestart: true,
            jsonMode: true,
            phase,
            updateRun: { runId, env: process.env },
            handoffFromGateway: async () => false,
          });
          expect(inspected.serviceUpdateVerdict?.kind).toBe("owned");
          if (authorized) {
            expect(inspected.blockMessage).toBeUndefined();
          } else {
            expect(inspected.blockMessage).toContain("inside the gateway process tree");
          }
          expect(service.stop).toHaveBeenCalledTimes(authorized && phase === "prepare" ? 1 : 0);
          expect(service.start).not.toHaveBeenCalled();
          expect(service.restart).not.toHaveBeenCalled();
          expect(service.stage).not.toHaveBeenCalled();
          expect(service.install).not.toHaveBeenCalled();
        },
      );
    }),
);

it.runIf(process.platform === "linux")(
  "rechecks the managed handoff identity immediately before stopping the Gateway",
  () =>
    withServiceHome(async (home) => {
      const root = await fs.realpath(process.cwd());
      const metaPath = path.join(home, "handoff-meta.json");
      const runId = randomUUID();
      createUpdateRun({ runId, trigger: "cli" }, { env: process.env });
      await fs.writeFile(
        metaPath,
        JSON.stringify({
          version: 1,
          meta: { root, runId, handoffId: "owned-handoff" },
        }),
      );
      const store = createManagedHandoffLeaseStore();
      const claim = store.acquire(root, "owned-handoff", { kind: "update" });
      if (claim.kind !== "acquired") {
        throw new Error("fixture could not acquire its installation lease");
      }
      let runtimeReads = 0;
      const stop = vi.fn(async () => undefined);
      mocks.service.mockReturnValue(
        createMockGatewayService({
          readCommand: async () => ({
            programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
            environment: { HOME: home },
          }),
          readRuntime: async () => {
            runtimeReads += 1;
            if (runtimeReads === 2) {
              const db = openNodeSqliteDatabase(path.join(home, "managed-update-handoffs.sqlite"));
              try {
                db.prepare(
                  "UPDATE managed_update_handoffs SET payload_json = json_set(payload_json, '$.executor.startIdentity', 'replaced') WHERE install_root = ?",
                ).run(root);
              } finally {
                db.close();
              }
            }
            return {
              status: "running",
              pid: process.ppid,
              systemd: { managerUid: 2001 },
            };
          },
          isLoaded: async () => true,
          stop,
        }),
      );
      await withEnvAsync(
        {
          OPENCLAW_UPDATE_RUN_HANDOFF: "1",
          [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
        },
        async () => {
          await expect(
            maybeStopManagedServiceBeforeMutableUpdate({
              root,
              updateInstallKind: "package",
              shouldRestart: true,
              jsonMode: true,
              phase: "prepare",
              updateRun: { runId, env: process.env },
            }),
          ).rejects.toThrow(/inside the gateway process tree/);
        },
      );
      expect(runtimeReads).toBe(2);
      expect(stop).not.toHaveBeenCalled();
    }),
);

it.each([
  { label: "changed account", uid: 3002 },
  { label: "missing account", uid: undefined },
  { label: "same account", uid: 2001 },
])("revalidates native manager identity before preparation: $label", (scenario) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    let managerUid: number | undefined = 2001;
    const stop = vi.fn(async () => undefined);
    mocks.service.mockReturnValue(
      createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        }),
        readRuntime: async () => ({ status: "running", systemd: { managerUid } }),
        isLoaded: async () => true,
        stop,
      }),
    );
    const params = {
      updateInstallKind: "package" as const,
      root: process.cwd(),
      shouldRestart: true,
      jsonMode: true,
      phase: "inspect" as const,
    };
    const before = await maybeStopManagedServiceBeforeMutableUpdate(params);
    expect(before.serviceUpdateVerdict?.kind).toBe("owned");
    expect(before).toMatchObject({ serviceManagerUid: 2001 });
    managerUid = scenario.uid;
    const next = maybeStopManagedServiceBeforeMutableUpdate({
      ...params,
      phase: "prepare",
      expectedService: before,
    });
    if (scenario.uid === 2001) {
      await expect(next).resolves.toMatchObject({
        stopped: true,
        serviceManagerUid: 2001,
        serviceUpdateVerdict: { kind: "owned" },
      });
    } else {
      await expect(next).rejects.toThrow(/ownership|manager identity/);
    }
    expect(stop).toHaveBeenCalledTimes(scenario.uid === 2001 ? 1 : 0);
  }),
);

it.each([
  "shipped handoff",
  "matching UID",
  "mismatching UID",
  "unavailable manager",
  "different unit",
  "different profile",
  "foreign executable",
  "changed protected command",
])("revalidates the shipped managed-service stop record: %s", (scenario) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    const root = process.cwd();
    const command = {
      programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
      environment: { HOME: home },
    };
    // v2026.9.2/v2026.9.3 forward this stop record to the fresh migration finalizer.
    const before: PreManagedServiceStop = {
      stoppedAtMs: 1,
      stopped: true,
      inspected: true,
      runtimeInspected: true,
      running: true,
      offline: false,
      serviceEnv: { HOME: home },
      serviceDefinitionEnv: command.environment,
      serviceNodeRunner: process.execPath,
      serviceUpdateVerdict: {
        kind: "owned",
        root,
        fingerprint: sha256Hex(stableStringify(command)),
        refreshDefinition: scenario !== "changed protected command",
      },
    };
    if (scenario === "matching UID" || scenario === "mismatching UID") {
      before.serviceManagerUid = scenario === "matching UID" ? 2001 : 3002;
    }
    const service = createMockGatewayService({
      readCommand: async () => ({
        ...command,
        programArguments:
          scenario === "foreign executable"
            ? [process.execPath, path.join(home, "other", "openclaw.mjs"), "gateway"]
            : scenario === "changed protected command"
              ? [...command.programArguments, "--verbose"]
              : command.programArguments,
        environment: {
          ...command.environment,
          ...(scenario === "different unit" ? { OPENCLAW_SYSTEMD_UNIT: "other-gateway" } : {}),
          ...(scenario === "different profile"
            ? {
                OPENCLAW_PROFILE: "other",
                OPENCLAW_STATE_DIR: path.join(home, ".openclaw-other"),
                OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw-other", "openclaw.json"),
              }
            : {}),
        },
      }),
      readRuntime: async () => ({
        status: "stopped",
        systemd: { managerUid: scenario === "unavailable manager" ? undefined : 2001 },
      }),
      isLoaded: async () => true,
    });
    const state = await readGatewayServiceState(service, {
      env: before.serviceEnv,
      requireEffective: true,
      requireLoadedCommand: true,
    });
    const revalidated = revalidateManagedGatewayServiceAfterUpdate({
      state,
      root,
      preManagedServiceStop: before,
    });
    if (scenario === "shipped handoff" || scenario === "matching UID") {
      await expect(revalidated).resolves.toMatchObject({ kind: "owned", refreshDefinition: true });
    } else {
      await expect(revalidated).rejects.toThrow(/ownership or manager identity changed/);
    }
  }),
);

it("refuses owned Linux admission without a native manager UID", () =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    const stop = vi.fn(async () => undefined);
    mocks.service.mockReturnValue(
      createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        }),
        readRuntime: async () => ({ status: "running" }),
        isLoaded: async () => true,
        stop,
      }),
    );
    await expect(
      maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: "package",
        root: process.cwd(),
        shouldRestart: true,
        jsonMode: true,
        phase: "inspect",
      }),
    ).resolves.toMatchObject({
      serviceUpdateVerdict: { kind: "unavailable" },
      serviceMutationAllowed: false,
    });
    expect(stop).not.toHaveBeenCalled();
  }));

it.each(["before stop", "after stop"] as const)(
  "refuses a rebound live executor %s without a new native effect",
  (when) =>
    withServiceHome(async (home) => {
      vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(
        path.join(home, "private-tmp"),
      );
      const root = process.cwd();
      const runId = randomUUID();
      createUpdateRun({ runId, trigger: "cli" }, { env: process.env });
      let reads = 0;
      const store = createManagedHandoffLeaseStore();
      const revoke = () => {
        const found = store.read(root);
        if (found.kind !== "current") {
          throw new Error("missing actual executor");
        }
        expect(store.bind(found.lease, process.pid)).not.toBeNull();
      };
      const stop = vi.fn(async () => {
        if (when === "after stop") {
          revoke();
        }
      });
      mocks.service.mockReturnValue(
        createMockGatewayService({
          readCommand: async () => ({
            programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
            environment: { HOME: home },
          }),
          readRuntime: async () => {
            reads += 1;
            await Promise.resolve();
            if (reads === 2 && when === "before stop") {
              revoke();
            }
            return { status: "running", systemd: { managerUid: process.getuid?.() ?? 2001 } };
          },
          isLoaded: async () => true,
          isEnabled: async () => true,
          stop,
        }),
      );
      let nativeFailure: unknown;
      await expect(
        withUpdateCommandExecutor(runId, async (executor) => {
          const executorFence = await executor.enter(root);
          try {
            await maybeStopManagedServiceBeforeMutableUpdate({
              updateRun: { runId, env: { ...process.env }, executorFence },
              updateInstallKind: "package",
              root,
              shouldRestart: true,
              jsonMode: true,
              phase: "prepare",
            });
          } catch (error) {
            nativeFailure = error;
          }
        }),
      ).rejects.toThrow(/executor/);
      expect(String(nativeFailure)).toMatch(/executor/);
      expect(stop).toHaveBeenCalledTimes(when === "before stop" ? 0 : 1);
      expect(store.read(root).kind).toBe("current");
    }),
);
