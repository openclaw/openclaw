import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { captureUpdateCommandExecutorAuthority } from "../cli/update-cli/update-command-executor.js";
import { withGatewayMaintenanceDrain } from "../cli/update-cli/update-command-service-drain.js";
import { createConfigIO } from "../config/io.factory.js";
import { withGatewayServiceOperationLock } from "../daemon/service-operation-lock.js";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { parsePackageOpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import {
  publishImmutablePointer,
  reconcileImmutablePointer,
} from "./package-update-activation-immutable-pointer.js";
import {
  prepareImmutableRecoveryRuntime,
  verifyImmutableRecoveryRuntime,
  resolveImmutableRecoveryCommand,
  readImmutableInstallRecordForRecovery,
} from "./package-update-activation-immutable-recovery.js";
import { updateImmutableInstallRecord } from "./package-update-activation-immutable.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "./restart-budget.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import { resolveUpdateFinalizationTimeoutMs } from "./update-finalization-budget.js";
import { verifyImmutableGeneration } from "./update-immutable-generation.js";
import { readImmutableInstallRecord } from "./update-immutable-install-record.js";
import type {
  ImmutableActivationOperation,
  ImmutableActivationPhase,
  ImmutableInstallRecord,
} from "./update-immutable-install-schema.js";
import { inspectImmutableInstall, projectImmutableInstall } from "./update-immutable-install.js";
import { assertImmutableDescriptorCurrent } from "./update-immutable-layout.js";
import { withImmutableUpdateOwner } from "./update-immutable-owner.js";
import {
  assertImmutableProtectionUnchanged,
  captureImmutableProtection,
  verifyImmutableProtection,
} from "./update-immutable-protection.js";
import {
  assertImmutableServiceStoppedCurrent,
  assertImmutableServiceProcessCurrent,
  controlImmutableService,
  inspectImmutableActivationService,
  type ImmutableServiceObservation,
} from "./update-immutable-service.js";
import {
  type ImmutableGatewayVerification,
  type ImmutableGatewayObservation,
  waitForImmutableGateway,
} from "./update-immutable-verification.js";

export type ImmutableActivationResult = {
  status: "succeeded" | "rolled-back" | "pending" | "error" | "already-current";
  operationId?: string;
  phase?: ImmutableActivationPhase;
  reason?: string;
  recoveryCommand?: string;
  installation: ReturnType<typeof projectImmutableInstall>;
};
type Options = {
  root: string;
  timeoutMs?: number;
  drainTimeoutMs?: number;
  onReceipt?: (line: string) => void;
};

async function assertUpdaterRuntime(record: ImmutableInstallRecord) {
  if (
    process.platform !== "linux" ||
    process.geteuid?.() !== 0 ||
    (await fs.realpath(process.execPath)) !== record.descriptor.runtime.path
  ) {
    throw new Error("Use the adopted external Node executable as the root Linux updater.");
  }
}

async function requireRecord(root: string) {
  const record = await readImmutableInstallRecord(root);
  if (!record?.descriptor.activationEnabled) {
    throw new Error(
      "Immutable activation is disabled. Explicitly adopt with --enable-activation first.",
    );
  }
  await assertUpdaterRuntime(record);
  return record;
}

async function verifyGeneration(
  generation: ImmutableActivationOperation["candidate"] | ImmutableActivationOperation["previous"],
  assertCurrent: () => void,
) {
  const verified = await verifyImmutableGeneration(generation.path, generation.sha);
  assertCurrent();
  if (
    verified.identity !== generation.identity ||
    verified.buildDigest !== generation.buildDigest
  ) {
    throw new Error("Sealed immutable generation no longer matches its recorded preparation.");
  }
}

/** Same-schema activation never migrates or rewinds live databases. Doctor rehearses private copies. */
async function rehearse(
  record: ImmutableInstallRecord,
  root: string,
  service: ImmutableServiceObservation,
  options: Options,
  assertCurrent: () => void,
) {
  const env = service.state.env;
  const { sourceConfig: config } = await createConfigIO({
    env,
    configPath: record.descriptor.service.configPath,
    observe: false,
    pluginValidation: "skip",
  }).readBestEffortConfigSnapshot();
  assertCurrent();
  const result = await validateUpdateCandidateCanary({
    root,
    sourceBundledPlugins: {
      packageRoot: record.descriptor.current.path,
      directory: resolveBundledPluginsDir(env),
    },
    config,
    stateDir: record.descriptor.service.stateDir,
    env,
    nodeRunner: record.descriptor.runtime.path,
    timeoutMs: options.timeoutMs,
    migrationPolicy: "startup-only",
    assertCurrent,
    onStep: () => options.onReceipt?.("immutable:canary-step"),
  });
  assertCurrent();
  if (
    result.status !== "ok" ||
    result.phase !== "readiness" ||
    result.steps.find((step) => step.name === "candidate-gateway-startup")?.exitCode !== 0
  ) {
    throw new Error(
      "Immutable candidate canary did not verify Doctor, plugins, startup and readiness; current is unchanged.",
    );
  }
}

function activationOwner(
  initial: ImmutableInstallRecord,
  assertOwner: () => void,
  options: Options,
) {
  let record = initial;
  const operation = () => {
    const value = record.activation?.operation;
    if (!value) {
      throw new Error("Immutable activation operation is missing.");
    }
    return value;
  };
  const assertCurrent = assertOwner;
  const assertStopped = () => {
    assertCurrent();
    const stopped = operation().stoppedService;
    if (!stopped) {
      throw new Error("Immutable stopped-service custody is unavailable; recovery retained.");
    }
    assertImmutableServiceStoppedCurrent(stopped);
  };
  const save = (changes: Partial<ImmutableActivationOperation>) => {
    record = updateImmutableInstallRecord(
      record,
      {
        ...record,
        activation: { ...record.activation, operation: { ...operation(), ...changes } },
      },
      assertCurrent,
    );
    options.onReceipt?.(`immutable:${operation().phase}`);
  };
  const inspect = (allowStarting = false) =>
    inspectImmutableActivationService({
      descriptor: record.descriptor,
      generationPath: record.descriptor.current.path,
      allowStopped: true,
      allowStarting,
      assertCurrent,
    });
  const assertService = (service: ImmutableServiceObservation) => {
    assertCurrent();
    assertImmutableDescriptorCurrent(record.descriptor);
    if (service.definitionDigest !== operation().serviceDigest) {
      throw new Error("Immutable service policy changed; recovery retained.");
    }
    if (service.phase === "running") {
      assertImmutableServiceProcessCurrent(service);
    }
  };
  const verifyProtection = (service: ImmutableServiceObservation) => {
    assertService(service);
    if (service.phase !== "running" || service.pid === null) {
      assertImmutableProtectionUnchanged(operation().protection, {
        env: service.state.env,
        assertCurrent,
      });
      return;
    }
    verifyImmutableProtection(operation().protection, {
      env: service.state.env,
      assertCurrent,
      candidate: {
        pid: service.pid,
        generationPath: record.descriptor.current.path,
        startedAtMs:
          operation().servingStartedAtMs ??
          operation().candidateStartedAtMs ??
          operation().startedAtMs,
        assertCurrent: () => assertService(service),
      },
    });
  };
  const pending = (reason: string): ImmutableActivationResult => {
    save({ failure: reason });
    return {
      status: "pending",
      operationId: operation().operationId,
      phase: operation().phase,
      reason,
      recoveryCommand: resolveImmutableRecoveryCommand(operation().recovery, record.descriptor),
      installation: projectImmutableInstall(record),
    };
  };
  const receipt = (
    status: "succeeded" | "rolled-back",
    service: ImmutableServiceObservation,
    retire: boolean,
    verification: ImmutableGatewayVerification | undefined,
  ): ImmutableActivationResult => {
    if (
      !verification ||
      verification.pid !== service.pid ||
      verification.generationSha !== record.descriptor.current.sha
    ) {
      throw new Error("Immutable completion requires its same-generation readiness receipt.");
    }
    verifyProtection(service);
    const op = operation();
    const retained =
      record.descriptor.current.sha === op.candidate.sha ? op.previous : op.candidate;
    record = updateImmutableInstallRecord(
      record,
      {
        ...record,
        prepared: record.descriptor.current.sha === op.candidate.sha ? null : record.prepared,
        activation: {
          previous: {
            sha: retained.sha,
            path: retained.path,
            identity: retained.identity,
            buildDigest: retained.buildDigest,
          },
          ...(!retire ? { operation: { ...op, phase: "rolled-back" as const } } : {}),
          lastResult: {
            operationId: op.operationId,
            outcome: status,
            selectedSha: record.descriptor.current.sha,
            verifiedAtMs: Date.now(),
            gateway: {
              pid: verification.pid,
              bootId: verification.bootId,
              version: verification.version,
              buildId: verification.buildId,
            },
          },
        },
      },
      () => assertService(service),
    );
    options.onReceipt?.(`immutable:${retire ? "retired" : "rolled-back"}`);
    return {
      status,
      installation: projectImmutableInstall(record),
      operationId: op.operationId,
      ...(!retire
        ? {
            phase: "rolled-back" as const,
            recoveryCommand: resolveImmutableRecoveryCommand(op.recovery, record.descriptor),
          }
        : {}),
    };
  };
  const observe = async () => {
    const service = await inspect(true);
    assertService(service);
    const timeoutMs =
      options.timeoutMs ??
      (await resolveUpdateFinalizationTimeoutMs(undefined, {
        env: service.state.env,
        nodeRunner: record.descriptor.runtime.path,
      }));
    assertService(service);
    return waitForImmutableGateway({
      descriptor: record.descriptor,
      generation: record.descriptor.current,
      timeoutMs,
      assertCurrent,
      onReceipt: options.onReceipt,
    });
  };
  const complete = async (
    status: "succeeded" | "rolled-back",
    observed: ImmutableGatewayObservation,
    retire: boolean,
  ): Promise<ImmutableActivationResult> => {
    const service = observed.service;
    if (observed.outcome !== "verified" || !service || !observed.verification) {
      return pending("verification-pending");
    }
    verifyProtection(service);
    const protection = await captureImmutableProtection({
      ...record.descriptor.service,
      env: service.state.env,
      assertCurrent,
    });
    verifyProtection(service);
    assertImmutableProtectionUnchanged(protection, { env: service.state.env, assertCurrent });
    save({ protection });
    options.onReceipt?.("immutable:post-start-canary");
    try {
      await rehearse(record, record.descriptor.current.path, service, options, assertCurrent);
    } catch (error) {
      assertCurrent();
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      return pending("post-start-canary-unverified");
    }
    assertService(service);
    const after = await observe();
    if (
      after.outcome !== "verified" ||
      !after.service ||
      after.verification?.bootId !== observed.verification.bootId ||
      after.service.pid !== service.pid
    ) {
      return pending("post-start-generation-unverified");
    }
    return receipt(status, after.service, retire, after.verification);
  };
  const stop = async (
    service: ImmutableServiceObservation,
    phase: "stopping" | "rollback-stopping",
  ) => {
    assertService(service);
    if (service.pid === null) {
      return;
    }
    await withGatewayMaintenanceDrain(
      {
        state: service.state,
        timeoutMs: options.drainTimeoutMs ?? resolveGatewayRestartDeferralTimeoutMs(),
        drainPolicy: "interrupt-after-drain",
        assertCurrent,
        warn: () => options.onReceipt?.("immutable:drain-warning"),
      },
      async ({ prepareEffect }) => {
        verifyProtection(service);
        if (!service.pid || !service.processStartTicks || !service.controlGroup) {
          throw new Error("Immutable stop requires current process custody.");
        }
        save({
          phase,
          stoppedService: {
            pid: service.pid,
            processStartTicks: service.processStartTicks,
            controlGroup: service.controlGroup,
          },
        });
        const assertProtected = () =>
          assertImmutableProtectionUnchanged(operation().protection, {
            env: service.state.env,
            assertCurrent,
          });
        await controlImmutableService("stop", {
          descriptor: record.descriptor,
          expected: service,
          assertCurrent,
          prepareEffect: () => prepareEffect(assertProtected),
          beforeEffect: assertProtected,
          stdout: process.stderr,
          timeoutMs: options.timeoutMs,
        });
      },
    );
    assertCurrent();
  };
  const start = async (rollback: boolean) => {
    const stopped = await inspect();
    assertService(stopped);
    if (stopped.pid !== null) {
      throw new Error("Immutable start refused: a generation is already serving.");
    }
    assertStopped();
    save({
      phase: rollback ? "rollback-starting" : "starting",
      servingStartedAtMs: Date.now(),
      ...(!rollback ? { candidateStartedAtMs: Date.now() } : {}),
    });
    await controlImmutableService("start", {
      descriptor: record.descriptor,
      expected: stopped,
      assertCurrent,
      stdout: process.stderr,
      timeoutMs: options.timeoutMs,
      beforeEffect: assertStopped,
    });
    assertCurrent();
  };
  const startAndVerifyPredecessor = async (
    recovering: boolean,
  ): Promise<ImmutableActivationResult> => {
    await start(true);
    const observed = await observe();
    return observed.outcome === "verified" && observed.service
      ? complete("rolled-back", observed, recovering)
      : pending(`${recovering ? "recovery" : "rollback"}-verification-pending`);
  };
  const rollback = async (): Promise<ImmutableActivationResult> => {
    const service = await inspect();
    verifyProtection(service);
    const protection = await captureImmutableProtection({
      ...record.descriptor.service,
      env: service.state.env,
      assertCurrent,
    });
    verifyProtection(service);
    // The predecessor rehearses these exact accepted bytes. A write during its
    // awaited rehearsal cannot become a new trusted protection baseline.
    await rehearse(record, operation().previous.path, service, options, assertCurrent);
    verifyProtection(service);
    assertImmutableProtectionUnchanged(protection, { env: service.state.env, assertCurrent });
    save({ protection, phase: "rollback-stopping" });
    await stop(service, "rollback-stopping");
    save({ phase: "rollback-publishing" });
    record = publishImmutablePointer(record, "previous", assertStopped);
    return startAndVerifyPredecessor(false);
  };
  const startAndVerifyCandidate = async (): Promise<ImmutableActivationResult> => {
    try {
      await start(false);
      save({ phase: "verifying" });
      const observed = await observe();
      if (observed.outcome === "verified" && observed.service) {
        return complete("succeeded", observed, true);
      }
      if (observed.outcome === "failed") {
        save({ failure: "candidate-verification-failed" });
        return await rollback();
      }
      return pending(
        observed.outcome === "still-starting"
          ? "candidate-still-starting"
          : "candidate-verification-pending",
      );
    } catch (error) {
      assertCurrent();
      // A failed start whose effect is definitely stopped is a real startup failure.
      // Uncertain publication, observation or custody stays with explicit recovery.
      if (operation().phase === "starting") {
        const service = await inspect(true);
        assertService(service);
        if (service.phase === "stopped") {
          save({ failure: "candidate-start-failed" });
          return rollback();
        }
      }
      save({ failure: "activation-interrupted" });
      throw error;
    }
  };
  return {
    async activate(): Promise<ImmutableActivationResult> {
      try {
        save({ phase: "draining" });
        const service = await inspect();
        await stop(service, "stopping");
        save({ phase: "stopped" });
        assertImmutableProtectionUnchanged(operation().protection, {
          env: service.state.env,
          assertCurrent,
        });
        save({ phase: "publishing" });
        record = publishImmutablePointer(record, "candidate", assertStopped);
        return startAndVerifyCandidate();
      } catch (error) {
        assertCurrent();
        save({ failure: "activation-interrupted" });
        throw error;
      }
    },
    async recover(): Promise<ImmutableActivationResult> {
      record = reconcileImmutablePointer(record, assertCurrent);
      const op = operation();
      await verifyGeneration(record.descriptor.current, assertCurrent);
      const observed = await observe();
      if (observed.outcome === "verified" && observed.service) {
        return complete(
          record.descriptor.current.sha === op.candidate.sha ? "succeeded" : "rolled-back",
          observed,
          true,
        );
      }
      if (observed.outcome === "still-starting" || observed.outcome === "unverified") {
        return pending("recovery-verification-pending");
      }
      const service = await inspect();
      verifyProtection(service);
      if (service.pid === null && !["prepared", "draining"].includes(op.phase)) {
        const rollingBack =
          op.phase.startsWith("rollback-") || op.pointerIntent?.targetSha === op.previous.sha;
        if (rollingBack) {
          await verifyGeneration(op.previous, assertCurrent);
          assertStopped();
          save({ phase: "rollback-publishing" });
          record = publishImmutablePointer(record, "previous", assertStopped);
        }
        if (record.descriptor.current.sha === op.candidate.sha) {
          return startAndVerifyCandidate();
        }
        return startAndVerifyPredecessor(true);
      }
      return record.descriptor.current.sha === op.candidate.sha
        ? rollback()
        : pending("predecessor-verification-failed");
    },
  };
}

export async function activateImmutableUpdate(
  options: Options & {
    expectedPrepared: NonNullable<ReturnType<typeof projectImmutableInstall>["prepared"]>;
  },
): Promise<ImmutableActivationResult> {
  const installation = await inspectImmutableInstall(options.root);
  if (!installation?.activationEnabled) {
    throw new Error("Immutable activation is disabled.");
  }
  return withImmutableUpdateOwner(installation.root, async (assertCurrent, fence) => {
    let record = await requireRecord(installation.root);
    assertCurrent();
    if (record.activation?.operation) {
      throw new Error("Immutable activation recovery is pending; run openclaw update recover.");
    }
    assertImmutableDescriptorCurrent(record.descriptor);
    const expected = options.expectedPrepared;
    const selected = record.descriptor.current;
    if (
      selected.sha === expected.sha &&
      selected.path === expected.path &&
      selected.buildDigest === expected.buildDigest
    ) {
      return { status: "already-current", installation: projectImmutableInstall(record) };
    }
    const candidate = record.prepared;
    if (
      !candidate ||
      candidate.sha !== expected.sha ||
      candidate.path !== expected.path ||
      candidate.buildDigest !== expected.buildDigest ||
      candidate.preparedAtMs !== expected.preparedAtMs
    ) {
      throw new Error(
        "Prepared immutable generation changed before activation; the serving generation was not stopped. Retry the requested update.",
      );
    }
    const service = await inspectImmutableActivationService({
      descriptor: record.descriptor,
      generationPath: record.descriptor.current.path,
      assertCurrent,
    });
    await verifyGeneration(record.descriptor.current, assertCurrent);
    await verifyGeneration(candidate, assertCurrent);
    const versions = await Promise.all(
      [record.descriptor.current, candidate].map(async (generation) =>
        parsePackageOpenClawSchemaVersions(
          JSON.parse(await fs.readFile(path.join(generation.path, "package.json"), "utf8")),
        ),
      ),
    );
    assertCurrent();
    if (
      !versions[0] ||
      !versions[1] ||
      !isDeepStrictEqual(versions[0], versions[1]) ||
      !isDeepStrictEqual(versions[1], candidate.schemaVersions)
    ) {
      throw new Error(
        "Immutable activation requires matching admitted schema contracts; prepare required offline migrations before cutover. Previous Gateway remains running.",
      );
    }
    options.onReceipt?.("immutable:canary");
    await rehearse(record, candidate.path, service, options, assertCurrent);
    const current = await inspectImmutableActivationService({
      descriptor: record.descriptor,
      generationPath: record.descriptor.current.path,
      assertCurrent,
    });
    if (
      current.pid !== service.pid ||
      current.processStartTicks !== service.processStartTicks ||
      current.definitionDigest !== service.definitionDigest
    ) {
      throw new Error("Serving generation changed during candidate rehearsal.");
    }
    options.onReceipt?.("immutable:recovery-preparing");
    const recovery = await prepareImmutableRecoveryRuntime({ record, assertCurrent });
    assertCurrent();
    assertImmutableServiceProcessCurrent(current);
    const protection = await captureImmutableProtection({
      ...record.descriptor.service,
      env: service.state.env,
      assertCurrent,
    });
    assertCurrent();
    assertImmutableServiceProcessCurrent(current);
    const operation: ImmutableActivationOperation = {
      version: 1,
      operationId: randomUUID(),
      authority: captureUpdateCommandExecutorAuthority(fence),
      phase: "prepared",
      previous: record.descriptor.current,
      candidate,
      serviceDigest: service.definitionDigest,
      protection,
      recovery,
      startedAtMs: Date.now(),
    };
    record = updateImmutableInstallRecord(
      record,
      { ...record, activation: { ...record.activation, operation } },
      assertCurrent,
    );
    options.onReceipt?.("immutable:prepared");
    return withGatewayServiceOperationLock(service.state.env, async (assertNative) => {
      const assertActivation = () => {
        assertCurrent();
        assertNative();
      };
      return activationOwner(record, assertActivation, options).activate();
    });
  });
}

export async function recoverImmutableUpdate(options: Options): Promise<ImmutableActivationResult> {
  const admission = await readImmutableInstallRecordForRecovery(path.resolve(options.root));
  const record = admission.record;
  await assertUpdaterRuntime(record);
  return withImmutableUpdateOwner(
    record.descriptor.root,
    async (assertCurrent) => {
      admission.admit(assertCurrent);
      options.onReceipt?.("immutable:control-recovered");
      const current = await readImmutableInstallRecord(record.descriptor.root);
      assertCurrent();
      if (!isDeepStrictEqual(current, record)) {
        throw new Error(
          "Immutable recovery changed during admission; retry from its current record.",
        );
      }
      if (!current) {
        throw new Error("Immutable installation disappeared during recovery.");
      }
      if (!current.activation?.operation) {
        return { status: "already-current", installation: projectImmutableInstall(current) };
      }
      await verifyImmutableRecoveryRuntime({
        reference: current.activation.operation.recovery,
        descriptor: current.descriptor,
        assertCurrent,
      });
      assertCurrent();
      return withGatewayServiceOperationLock(
        { OPENCLAW_SYSTEMD_UNIT: current.descriptor.service.unit },
        async (assertNative) => {
          const assertRecovery = () => {
            assertCurrent();
            assertNative();
          };
          return activationOwner(current, assertRecovery, options).recover();
        },
      );
    },
    record.activation?.operation?.authority,
    { recover: true },
  );
}
