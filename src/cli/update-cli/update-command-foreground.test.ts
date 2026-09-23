import "./update-command-execution.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as openClawRoot from "../../infra/openclaw-root.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import * as candidateState from "../../infra/update-candidate-state.js";
import * as updateCheck from "../../infra/update-check.js";
import {
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  UPDATE_RUN_ID_ENV,
} from "../../infra/update-control-plane-sentinel.js";
import * as finalizationBudget from "../../infra/update-finalization-budget.js";
import {
  POST_CORE_UPDATE_ENV,
  POST_CORE_UPDATE_CHANNEL_ENV,
} from "../../infra/update-post-core-context.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import * as updateRunLedger from "../../infra/update-run-ledger.js";
import { ExitError } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as stateOwnership from "../../state/openclaw-state-ownership.js";
import * as shared from "./shared.js";
import * as admissionEnvOwner from "./update-command-admission-env.js";
import { resolveUpdateCommandAdmissionEnv } from "./update-command-admission-env.js";
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

const { executionParams, mocks, schemaContext, successfulUpdate } =
  await import("./update-command-execution.test-support.js");
const dirs = useAutoCleanupTempDirTracker(afterEach);
const foregroundRunId = "b834d63c-0310-4a9b-9b04-48b6b5da6cfe";
let claimPath: string;
beforeEach(async () => {
  const home = dirs.make("foreground-claim-");
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(home);
  claimPath = path.join(home, "sentinel-meta.json");
  await fs.writeFile(
    claimPath,
    JSON.stringify({
      version: 1,
      meta: { runId: foregroundRunId, completionOwner: "gateway-restart" },
    }),
  );
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

async function expectReportedAdmissionRefusal(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toBeInstanceOf(ExitError);
  await expect(operation).rejects.toMatchObject({ code: 1 });
  expect(mocks.runtimeWriteJson).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ status: "error", reason: "managed-service-preflight" }),
  );
  expect(mocks.runtimeError).toHaveBeenCalledWith(
    expect.stringContaining("Retry the update from its current owner."),
  );
}

it.each([
  ...(["prepare", "environment", "database"] as const).flatMap((boundary) =>
    (["unverified", "expired"] as const).map((response) => ({ boundary, response })),
  ),
  { boundary: "prepare", response: "missing" },
  { boundary: "environment", response: "malformed" },
  { boundary: "database", response: "invalid-envelope" },
  { boundary: "command", response: "missing" },
  { boundary: "command", response: "origin-only" },
  { boundary: "command", response: "invalid-completion" },
] as const)(
  "refuses invalid handoff $boundary admission: $response",
  async ({ boundary, response }) => {
    const root = dirs.make("foreground-admission-");
    vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
    vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
    const nativePlan = vi
      .spyOn(servicePlan, "resolveManagedServicePackageUpdatePlan")
      .mockResolvedValue({ rootRedirect: null });
    const nativeOwner = vi
      .spyOn(servicePlan, "readManagedGatewayServiceForUpdate")
      .mockResolvedValue(null);
    const state = vi
      .spyOn(stateOwnership, "assertOpenClawStateWriteAllowedAtPath")
      .mockResolvedValue(undefined);
    const create = vi.spyOn(updateRunLedger, "createUpdateRun").mockImplementation(() => {
      throw new Error("Unexpected ledger creation from invalid handoff metadata");
    });
    const adopt = vi.spyOn(updateRunLedger, "adoptUpdateRun");
    if (boundary === "command") {
      nativePlan.mockRejectedValue(
        new Error("Unexpected native plan from invalid handoff metadata"),
      );
    }
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
      await fs.writeFile(
        claimPath,
        JSON.stringify({
          version: 1,
          meta: {
            runId: foregroundRunId,
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
          },
        }),
      );
    }
    const options = { opts: { json: true }, root };
    const operation =
      boundary === "prepare"
        ? prepareUpdateCommand(options.opts)
        : boundary === "environment"
          ? resolveUpdateCommandAdmissionEnv(options)
          : boundary === "command"
            ? updateCommand(options.opts)
            : inspectUpdateDatabaseContexts({
                roots: [root],
                updateInstallKind: "package",
                shouldRestart: true,
                jsonMode: true,
                timeoutMs: 1000,
                managedServiceRootRedirect: null,
              });
    if (boundary === "command") {
      await expectReportedAdmissionRefusal(operation);
    } else {
      await expect(operation.then(() => "admitted")).rejects.toMatchObject({
        reason: "managed-service-preflight",
      });
      expect(mocks.runtimeWriteJson).not.toHaveBeenCalled();
    }
    await Promise.resolve();
    expect(handoff.inspect).toHaveBeenCalledTimes(handshakeRefusal ? 1 : 0);
    expect(nativePlan).not.toHaveBeenCalled();
    expect(nativeOwner).not.toHaveBeenCalled();
    expect(mocks.maybeStopService).not.toHaveBeenCalled();
    expect(mocks.captureSchemaContext).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
  },
);

it("keeps post-core continuation separate from foreground request admission", async () => {
  const root = dirs.make("foreground-post-core-");
  await fs.writeFile(
    claimPath,
    JSON.stringify({
      version: 1,
      meta: { root, runId: foregroundRunId, completionOwner: "gateway-restart" },
    }),
  );
  vi.stubEnv(POST_CORE_UPDATE_ENV, "1");
  vi.stubEnv(POST_CORE_UPDATE_CHANNEL_ENV, "stable");
  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
  vi.spyOn(openClawRoot, "resolveOpenClawPackageRootSync").mockReturnValue(root);
  vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
  const nativePlan = vi
    .spyOn(servicePlan, "resolveManagedServicePackageUpdatePlan")
    .mockResolvedValue({ rootRedirect: null });
  handoff.inspect.mockResolvedValue(false);
  const prepared = await prepareUpdateCommand({ json: true, dryRun: true });
  expect(prepared).toMatchObject({ postCoreUpdateResume: true, discoveredRoot: root });
  expect(prepared.servicePlan).toBeUndefined();
  expect(handoff.inspect).not.toHaveBeenCalled();
  expect(nativePlan).not.toHaveBeenCalled();
});

it.each(["preparation", "environment", "state preflight"] as const)(
  "refuses a foreground claim lost after successful %s before ledger admission",
  async (boundary) => {
    const root = dirs.make("foreground-interleave-");
    vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
    vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
    const nativePlan = vi
      .spyOn(servicePlan, "resolveManagedServicePackageUpdatePlan")
      .mockResolvedValue({ rootRedirect: null });
    const nativeOwner = vi
      .spyOn(servicePlan, "readManagedGatewayServiceForUpdate")
      .mockResolvedValue(null);
    const before = createUpdateRun({ runId: foregroundRunId, trigger: "api" });
    const create = vi.spyOn(updateRunLedger, "createUpdateRun").mockImplementation(() => {
      throw new Error("Unexpected ledger creation after foreground claim loss");
    });
    const adopt = vi.spyOn(updateRunLedger, "adoptUpdateRun");
    let admitting = false;
    let expired = false;
    const expire = async () => {
      await fs.rm(claimPath);
      expired = true;
    };
    const prepare = commandRun.prepareUpdateCommand;
    vi.spyOn(commandRun, "prepareUpdateCommand").mockImplementation(async (opts) => {
      const prepared = await prepare(opts);
      if (boundary === "preparation") {
        await expire();
      }
      return prepared;
    });
    const resolveEnv = admissionEnvOwner.resolveUpdateCommandAdmissionEnv;
    vi.spyOn(admissionEnvOwner, "resolveUpdateCommandAdmissionEnv").mockImplementation(
      async (params) => {
        const env = await resolveEnv(params);
        if (boundary === "environment") {
          await expire();
        }
        return env;
      },
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

    await expectReportedAdmissionRefusal(updateCommand({ json: true }));
    expect(expired).toBe(true);
    expect(handoff.inspect).toHaveBeenCalled();
    expect(nativePlan).not.toHaveBeenCalled();
    expect(nativeOwner).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
    expect(updateRunLedger.getUpdateRun(before.runId)).toEqual(before);
  },
);

it.each(["absent", "blank", "native"] as const)(
  "keeps %s metadata on native admission",
  async (marker) => {
    if (marker === "native") {
      await fs.writeFile(
        claimPath,
        JSON.stringify({ version: 1, meta: { runId: foregroundRunId } }),
      );
    } else {
      vi.stubEnv(CONTROL_PLANE_UPDATE_SENTINEL_META_ENV, marker === "blank" ? " \t " : undefined);
      vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
    }
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", marker === "native" ? "1" : undefined);
    handoff.inspect.mockResolvedValue(false);
    const admitted = await inspectUpdateDatabaseContexts({
      roots: ["/opt/openclaw"],
      updateInstallKind: "package",
      shouldRestart: true,
      jsonMode: true,
      timeoutMs: 1000,
      managedServiceRootRedirect: null,
    });
    expect(admitted.foreground).toBeUndefined();
    expect(admitted.managedEnv).toEqual(schemaContext("default").env);
    expect(mocks.maybeStopService).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ phase: "inspect" }),
    );
    expect(handoff.inspect).not.toHaveBeenCalled();
  },
);

it.each(["schema", "execution", "already current"] as const)(
  "preserves admitted foreground intent at initial %s inspection",
  async (boundary) => {
    const params = executionParams("package");
    params.root = dirs.make("foreground-admitted-");
    params.opts.run = {
      runId: createUpdateRun({ runId: foregroundRunId, trigger: "api" }).runId,
      env: { ...process.env },
      completionOwner: "gateway-restart",
    };
    const refuseUpdate: RefuseUpdate = async (reason, message) => {
      throw new shared.UpdatePreMutationError(reason, message ?? reason);
    };
    mocks.maybeStopService.mockRejectedValue(
      new Error("Unexpected native inspection after foreground claim loss"),
    );
    await fs.rm(claimPath);
    if (boundary === "execution") {
      const result = await executeMutableUpdate(params);
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
              packageInstallSpec: params.packageInstallSpec ?? null,
              refuseUpdate,
            });
      await expect(operation.then(() => "admitted")).rejects.toMatchObject({
        reason: "managed-service-preflight",
      });
    }
    expect(mocks.maybeStopService).not.toHaveBeenCalled();
    expect(mocks.captureSchemaContext).not.toHaveBeenCalled();
    expect(mocks.captureManagedPreflight).not.toHaveBeenCalled();
    expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
  },
);

it.each(["active", "unknown", "offline", "absent", "foreign"] as const)(
  "keeps foreground admission separate from native ownership: %s",
  async (native) => {
    const root = "/opt/openclaw";
    const state: PreManagedServiceStop = {
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
    const admission = inspectUpdateDatabaseContexts({
      roots: [root],
      updateInstallKind: "package",
      shouldRestart: true,
      jsonMode: true,
      timeoutMs: 1000,
      managedServiceRootRedirect: null,
    });
    if (native === "active" || native === "unknown") {
      await expect(admission).rejects.toMatchObject({ reason: "managed-service-preflight" });
      expect(mocks.captureManagedPreflight).not.toHaveBeenCalled();
    } else {
      const value = await admission;
      expect(value.foreground).toBe(true);
      expect(value.managedEnv).toBeUndefined();
      expect(value.services.get(root)).toBe(state);
      expect(value.contexts[0]?.configSnapshot.path).toBe("/fixture/invoker/openclaw.json");
    }
    expect(mocks.maybeStopService).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ phase: "inspect" }),
    );
  },
);

it("refuses a foreground helper that loses its admitted ownership", async () => {
  mocks.maybeStopService.mockResolvedValue({
    stopped: false,
    inspected: true,
    runtimeInspected: true,
    running: false,
    serviceUpdateVerdict: { kind: "absent" },
  });
  const params = {
    roots: ["/opt/openclaw"],
    updateInstallKind: "package" as const,
    shouldRestart: true,
    jsonMode: true,
    timeoutMs: 1000,
    managedServiceRootRedirect: null,
  };
  const admitted = await inspectUpdateDatabaseContexts(params);
  handoff.inspect.mockResolvedValue(false);
  await expect(
    inspectUpdateDatabaseContexts({
      ...params,
      expectedServices: admitted.services,
      expectedForeground: admitted.foreground,
    }),
  ).rejects.toMatchObject({ reason: "managed-service-preflight" });
  expect(mocks.maybeStopService).toHaveBeenCalledOnce();
});

it.each([
  { capable: true, migrating: true, omittedTimeout: false },
  { capable: false, migrating: false, omittedTimeout: false },
  { capable: false, migrating: true, omittedTimeout: false },
  { capable: true, migrating: true, omittedTimeout: true },
])(
  "parks foreground activation after candidate admission (capable=$capable, migrating=$migrating, omittedTimeout=$omittedTimeout)",
  async ({ capable, migrating, omittedTimeout }) => {
    const root = dirs.make("foreground-candidate-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    const env = { ...process.env };
    const params = executionParams("package");
    params.root = root;
    params.timeoutMs = omittedTimeout ? undefined : 30_000;
    params.opts.timeout = omittedTimeout ? undefined : "30";
    params.opts.run = {
      runId: createUpdateRun({ trigger: "api" }, { env }).runId,
      env,
      completionOwner: "gateway-restart",
    };
    mocks.captureSchemaContext.mockResolvedValue({
      ...schemaContext("caller"),
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
    });
    vi.spyOn(candidateState, "readUpdateStateSchemaVersions").mockResolvedValue([
      { path: path.join(root, "state", "openclaw.sqlite"), userVersion: migrating ? 14 : 15 },
    ]);
    const budget = vi
      .spyOn(finalizationBudget, "resolveUpdateFinalizationTimeoutMs")
      .mockResolvedValue(1_000);
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
      return executeMutableUpdate(params);
    });
    if (!capable && migrating) {
      expect(result?.result).toMatchObject({
        status: "error",
        reason: "target-native-unsupported",
      });
      expect(events).toEqual(["prepare"]);
      expect(budget).not.toHaveBeenCalled();
    } else {
      expect(result?.result.status).toBe("ok");
      expect(events).toEqual(["prepare", "park", "prepare", "publish"]);
      expect(mocks.prepareMutableUpdate.mock.lastCall?.[1]).toBe(
        omittedTimeout ? undefined : 1_000,
      );
      expect(budget).toHaveBeenCalledTimes(omittedTimeout ? 0 : 1);
      expect(params.opts.run.gatewayRestartRequired).toBe(true);
    }
    expect(mocks.captureManagedContext).not.toHaveBeenCalled();
    expect(mocks.maybeStopService.mock.calls.every(([step]) => step.phase === "inspect")).toBe(
      true,
    );
  },
);
