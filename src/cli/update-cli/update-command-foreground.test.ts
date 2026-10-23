import "./update-command-execution.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as openClawRoot from "../../infra/openclaw-root.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import * as candidateState from "../../infra/update-candidate-state.js";
import * as updateCheck from "../../infra/update-check.js";
import {
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  UPDATE_RUN_ID_ENV,
} from "../../infra/update-control-plane-sentinel.js";
import {
  POST_CORE_UPDATE_ENV,
  POST_CORE_UPDATE_CHANNEL_ENV,
} from "../../infra/update-post-core-context.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import * as updateRunLedger from "../../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as stateOwnership from "../../state/openclaw-state-ownership-preflight.js";
import { updateConfigSource } from "./schema-preflight.js";
import * as shared from "./shared.js";
import { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import * as managedContext from "./update-command-managed-context.js";
import { finishAlreadyCurrentUpdate } from "./update-command-noop.js";
import type { RefuseUpdate } from "./update-command-result.js";
import * as commandRun from "./update-command-run.js";
import { prepareUpdateCommand } from "./update-command-run.js";
import { preflightUpdateCommandSchemas } from "./update-command-schema.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

const handoff = vi.hoisted(() => ({ inspect: vi.fn(async () => true), park: vi.fn() }));
vi.mock("../../infra/update-managed-service-handoff.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-managed-service-handoff.js")>()),
  isCurrentForegroundUpdateHandoffProcess: handoff.inspect,
  parkForegroundUpdateHandoff: handoff.park,
}));

const { bindExecutionGuards, executionParams, mocks, schemaContext, successfulUpdate } =
  await import("./update-command-execution.test-support.js");
const dirs = useAutoCleanupTempDirTracker(afterEach);
const foregroundRunId = "b834d63c-0310-4a9b-9b04-48b6b5da6cfe";
let claimPath: string;
const expectNotCalled = (...spies: MockInstance[]) => {
  for (const spy of spies) {
    expect(spy).not.toHaveBeenCalled();
  }
};
function mockPackageRoot(root: string) {
  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
  vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
}
const writeClaim = (meta: object) =>
  fs.writeFile(
    claimPath,
    JSON.stringify({ version: 1, meta: { runId: foregroundRunId, ...meta } }),
  );
const expectRefusal = (operation: Promise<unknown>) =>
  expect(operation).rejects.toMatchObject({ reason: "managed-service-preflight" });
function admissionSpies() {
  return {
    nativePlan: vi.spyOn(servicePlan, "resolveManagedServicePackageUpdatePlan"),
    nativeOwner: vi
      .spyOn(servicePlan, "readManagedGatewayServiceForUpdate")
      .mockResolvedValue(null),
    create: vi.spyOn(updateRunLedger, "createUpdateRun").mockImplementation(() => {
      throw new Error("Unexpected ledger creation before foreground admission");
    }),
    adopt: vi.spyOn(updateRunLedger, "adoptUpdateRun"),
  };
}
function foregroundRun(env = { ...process.env }, runId?: string) {
  return {
    runId: createUpdateRun({ runId, trigger: "api" }, { env }).runId,
    env,
    completionOwner: "gateway-restart" as const,
  };
}

beforeEach(async () => {
  const home = dirs.make("foreground-claim-");
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(home);
  claimPath = path.join(home, "sentinel-meta.json");
  await writeClaim({ completionOwner: "gateway-restart" });
  vi.stubEnv(CONTROL_PLANE_UPDATE_SENTINEL_META_ENV, claimPath);
  vi.stubEnv(UPDATE_RUN_ID_ENV, foregroundRunId);
  vi.stubEnv("OPENCLAW_STATE_DIR", home);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(home, "openclaw.json"));
  vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", undefined);
  handoff.inspect.mockReset().mockResolvedValue(true);
  handoff.park.mockReset();
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it.each([
  "unverified",
  "expired",
  "missing",
  "malformed",
  "invalid-envelope",
  "origin-only",
  "invalid-completion",
] as const)("refuses invalid handoff command admission: %s", async (response) => {
  const root = dirs.make("foreground-admission-");
  mockPackageRoot(root);
  const { nativePlan, nativeOwner, create, adopt } = admissionSpies();
  nativePlan.mockRejectedValue(new Error("Unexpected native plan from invalid handoff metadata"));
  const state = vi
    .spyOn(stateOwnership, "assertOpenClawStateWriteAllowedAtPath")
    .mockResolvedValue(undefined);
  const handshakeRefusal = response === "unverified" || response === "expired";
  if (handshakeRefusal) {
    handoff.inspect.mockImplementationOnce(async () => {
      if (response === "expired") {
        await fs.rm(claimPath);
      }
      return false;
    });
  } else if (response === "missing") {
    await fs.rm(claimPath);
  } else if (response === "malformed" || response === "invalid-envelope") {
    await fs.writeFile(claimPath, response === "malformed" ? "{" : '{"version":2,"meta":{}}');
  } else {
    await writeClaim({
      completionOwner: response === "origin-only" ? undefined : "native",
      foregroundOrigin: {
        owner: "fixture-owner",
        pid: process.pid,
        host: "localhost",
        startedAt: 1,
        port: 18789,
        stateDatabasePath: path.join(root, "state.sqlite"),
        configPath: path.join(root, "openclaw.json"),
      },
    });
  }
  await expectRefusal(updateCommand({ json: true }));
  expect(handoff.inspect).toHaveBeenCalledTimes(handshakeRefusal ? 1 : 0);
  expectNotCalled(nativePlan, nativeOwner, mocks.maybeStopService, mocks.captureSchemaContext);
  expectNotCalled(state, create, adopt);
});

it("keeps post-core continuation separate from foreground request admission", async () => {
  const root = dirs.make("foreground-post-core-");
  await writeClaim({ root, completionOwner: "gateway-restart" });
  vi.stubEnv(POST_CORE_UPDATE_ENV, "1");
  vi.stubEnv(POST_CORE_UPDATE_CHANNEL_ENV, "stable");
  mockPackageRoot(root);
  vi.spyOn(openClawRoot, "resolveOpenClawPackageRootSync").mockReturnValue(root);
  const nativePlan = vi
    .spyOn(servicePlan, "resolveManagedServicePackageUpdatePlan")
    .mockResolvedValue({ rootRedirect: null });
  handoff.inspect.mockResolvedValue(false);
  const prepared = await prepareUpdateCommand({ json: true, dryRun: true });
  expect(prepared).toMatchObject({ postCoreUpdateResume: true, discoveredRoot: root });
  expect(prepared.servicePlan).toBeUndefined();
  expectNotCalled(handoff.inspect, nativePlan);
});

it.each(["preparation", "environment", "state preflight"] as const)(
  "refuses a foreground claim lost after successful %s before ledger admission",
  async (boundary) => {
    const root = dirs.make("foreground-interleave-");
    mockPackageRoot(root);
    const before = createUpdateRun({ runId: foregroundRunId, trigger: "api" });
    const { nativePlan, nativeOwner, create, adopt } = admissionSpies();
    nativePlan.mockResolvedValue({ rootRedirect: null });
    let admitting = false;
    let expired = false;
    const expire = async () => {
      await fs.rm(claimPath);
      expired = true;
    };
    const expireAfter = async <T>(operation: Promise<T>, at: typeof boundary) => {
      const result = await operation;
      if (boundary === at) {
        await expire();
      }
      return result;
    };
    const prepare = commandRun.prepareUpdateCommand;
    vi.spyOn(commandRun, "prepareUpdateCommand").mockImplementation((opts) =>
      expireAfter(prepare(opts), "preparation"),
    );
    const resolveEnv = commandRun.resolveUpdateCommandAdmissionEnv;
    vi.spyOn(commandRun, "resolveUpdateCommandAdmissionEnv").mockImplementation((params) =>
      expireAfter(resolveEnv(params), "environment"),
    );
    const admit = commandRun.admitUpdateCommandRun;
    vi.spyOn(commandRun, "admitUpdateCommandRun").mockImplementation(async (params) => {
      admitting = true;
      return await admit(params);
    });
    vi.spyOn(stateOwnership, "assertOpenClawStateWriteAllowedAtPath").mockImplementation(
      async () => {
        if (admitting && boundary === "state preflight") {
          await expire();
        }
      },
    );

    await expectRefusal(updateCommand({ json: true }).then(() => "admitted"));
    expect(expired).toBe(true);
    expect(handoff.inspect).toHaveBeenCalled();
    expectNotCalled(nativePlan, nativeOwner, create, adopt);
    expect(updateRunLedger.getUpdateRun(before.runId)).toEqual(before);
  },
);

it.each(["schema", "execution", "already current"] as const)(
  "preserves admitted foreground intent at initial %s inspection",
  async (boundary) => {
    const params = executionParams("package");
    params.root = dirs.make("foreground-admitted-");
    params.opts.run = foregroundRun(undefined, foregroundRunId);
    const refuseUpdate: RefuseUpdate = async (reason, message) => {
      throw new shared.UpdatePreMutationError(reason, message ?? reason);
    };
    mocks.maybeStopService.mockRejectedValue(
      new Error("Unexpected native inspection after foreground claim loss"),
    );
    await fs.rm(claimPath);
    if (boundary === "execution") {
      const result = await executeMutableUpdate(await bindExecutionGuards(params));
      expect(result?.result).toMatchObject({
        status: "error",
        reason: "managed-service-preflight",
      });
    } else {
      const operation =
        boundary === "schema"
          ? preflightUpdateCommandSchemas({ ...params, refuseUpdate })
          : finishAlreadyCurrentUpdate({
              ...params,
              result: successfulUpdate,
              requestedChannel: null,
              storedChannel: null,
              controlPlaneUpdateSentinelMeta: null,
              refuseUpdate,
            });
      await expectRefusal(operation.then(() => "admitted"));
    }
    expectNotCalled(
      mocks.maybeStopService,
      mocks.captureSchemaContext,
      mocks.captureManagedPreflight,
      mocks.prepareMutableUpdate,
    );
  },
);

it.each([
  { marker: "absent", native: "default" },
  { marker: "blank", native: "default" },
  { marker: "native", native: "default" },
  { marker: "foreground", native: "active" },
  { marker: "foreground", native: "unknown" },
  { marker: "foreground", native: "offline" },
  { marker: "foreground", native: "absent" },
  { marker: "foreground", native: "foreign" },
] as const)(
  "separates $marker admission from $native service ownership",
  async ({ marker, native }) => {
    const root = "/opt/openclaw";
    const foreground = marker === "foreground";
    let state: PreManagedServiceStop | undefined;
    if (!foreground) {
      if (marker === "native") {
        await writeClaim({});
      } else {
        vi.stubEnv(CONTROL_PLANE_UPDATE_SENTINEL_META_ENV, marker === "blank" ? " \t " : undefined);
        vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
      }
      vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", marker === "native" ? "1" : undefined);
      handoff.inspect.mockResolvedValue(false);
    } else {
      state = {
        stopped: false,
        inspected: true,
        runtimeInspected: native !== "unknown",
        running: native === "active" || native === "foreign",
        offline: native === "offline",
        serviceEnv: { OPENCLAW_PROFILE: "native" },
        serviceUpdateVerdict:
          native === "absent" || native === "foreign"
            ? { kind: native }
            : { kind: "owned", root, fingerprint: "native", refreshDefinition: false },
      };
      mocks.maybeStopService.mockResolvedValue(state);
      mocks.captureManagedPreflight.mockResolvedValue(
        state.serviceUpdateVerdict?.kind === "owned" ? schemaContext("native") : undefined,
      );
    }
    const params = {
      roots: [root],
      updateInstallKind: "package" as const,
      shouldRestart: true,
      jsonMode: true,
      timeoutMs: 1000,
      managedServiceRootRedirect: null,
    };
    const admission = inspectUpdateDatabaseContexts(params);
    if (native === "active" || native === "unknown") {
      await expectRefusal(admission);
      expect(mocks.captureManagedPreflight).not.toHaveBeenCalled();
    } else {
      const value = await admission;
      if (foreground) {
        expect([value.foreground, value.managedEnv]).toEqual([true, undefined]);
        expect(value.services.get(root)).toBe(state);
        expect(value.contexts[0]?.configSnapshot.path).toBe("/fixture/invoker/openclaw.json");
        if (native === "absent") {
          handoff.inspect.mockResolvedValue(false);
          await expectRefusal(
            inspectUpdateDatabaseContexts({
              ...params,
              expectedServices: value.services,
              expectedForeground: value.foreground,
            }),
          );
        }
      } else {
        expect([value.foreground, value.managedEnv]).toEqual([
          undefined,
          schemaContext("default").env,
        ]);
        expect(handoff.inspect).not.toHaveBeenCalled();
      }
    }
    expect(mocks.maybeStopService).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ phase: "inspect" }),
    );
  },
);

it.each<{
  capable: boolean;
  migrating: boolean;
  omittedTimeout: boolean;
  local?: { family: "client" | "daemon"; version: number };
}>([
  { capable: true, migrating: true, omittedTimeout: false },
  { capable: false, migrating: false, omittedTimeout: false },
  { capable: false, migrating: true, omittedTimeout: false },
  { capable: true, migrating: true, omittedTimeout: true },
  ...(["client", "daemon"] as const).flatMap((family) =>
    [1, 2].map((version) => ({
      capable: false,
      migrating: false,
      omittedTimeout: false,
      local: { family, version },
    })),
  ),
])(
  "parks foreground activation after candidate admission (capable=$capable, migrating=$migrating, omittedTimeout=$omittedTimeout, local=$local)",
  async ({ capable, migrating, omittedTimeout, local }) => {
    const root = dirs.make("foreground-candidate-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    const env = { ...process.env };
    const params = executionParams("package");
    params.root = root;
    params.opts.run = foregroundRun(env);
    params.timeoutMs = omittedTimeout ? undefined : 30_000;
    params.opts.timeout = omittedTimeout ? undefined : "30";
    const caller = schemaContext("caller");
    mocks.captureSchemaContext.mockResolvedValue({
      ...caller,
      env,
      readEnv: env,
    });
    mocks.captureManagedPreflight.mockResolvedValue(undefined);
    mocks.maybeStopService.mockResolvedValue({
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: false,
      serviceUpdateVerdict: { kind: "absent" },
    });
    vi.spyOn(managedContext, "readUpdateCandidateSource").mockResolvedValue({
      config: {},
      hash: "unchanged",
      source: updateConfigSource({
        ...caller.configSnapshot,
        path: path.join(root, "openclaw.json"),
        hash: "unchanged",
      }),
    });
    vi.spyOn(candidateState, "readUpdateStateSchemaVersions").mockResolvedValue([
      { path: path.join(root, "state", "openclaw.sqlite"), userVersion: migrating ? 14 : 15 },
      ...(local
        ? [
            {
              path: path.join(
                root,
                local.family === "client" ? "client/credentials.sqlite" : "control/services.sqlite",
              ),
              userVersion: local.version,
            },
          ]
        : []),
    ]);
    mocks.validateCanary.mockResolvedValue({
      status: "ok",
      phase: "readiness",
      candidateSchemaVersions: { state: 15, agent: 19 },
      gatewayRestartCompletion: capable,
      steps: [],
      durationMs: 1,
      logTail: [],
    });
    const events: string[] = [];
    handoff.park.mockImplementation(async ({ run }) => {
      events.push("park");
      run.gatewayRestartRequired = true;
    });
    mocks.runPackageUpdate.mockImplementation(async ({ validateCandidate, beforeActivate }) => {
      await validateCandidate(root);
      await beforeActivate();
      events.push("publish");
      return { ...successfulUpdate, root };
    });
    const result = await withUpdateCommandExecutor(params.opts.run.runId, async (executor) => {
      mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
        events.push("prepare");
        admitExecutor(await executor.enter(root));
      });
      return executeMutableUpdate(await bindExecutionGuards(params));
    });
    if (!capable && (migrating || (local !== undefined && local.version !== 1))) {
      expect(result?.result).toMatchObject({
        status: "error",
        reason: "target-native-unsupported",
      });
      expect(events).toEqual(["prepare"]);
    } else {
      expect(result?.result.status).toBe("ok");
      expect(events).toEqual(["prepare", "park", "prepare", "publish"]);
      expect(mocks.prepareMutableUpdate.mock.lastCall?.[1]).toBe(
        omittedTimeout ? undefined : 30_000,
      );
      expect(params.opts.run.gatewayRestartRequired).toBe(true);
    }
    expect(mocks.captureManagedContext).not.toHaveBeenCalled();
    expect(mocks.maybeStopService.mock.calls.every(([step]) => step.phase === "inspect")).toBe(
      true,
    );
  },
);
