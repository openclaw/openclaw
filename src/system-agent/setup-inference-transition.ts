import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readConfigFileSnapshot, transformConfigFileWithRetry } from "../config/config.js";
import type { ConfigWriteOptions } from "../config/io.js";
import { applyMergePatch, createMergePatch } from "../config/merge-patch.js";
import {
  createRuntimeConfigWriteApplication,
  attachRuntimeConfigWriteApplication,
  copyRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../process/gateway-work-admission.js";
import { SetupInferenceOwnerDriftError } from "./setup-inference-core.js";
import type { SetupCredentialActivationReceipt } from "./setup-inference-credential-access.js";

export type SetupInferenceConfigUndo = (
  options: ConfigWriteOptions,
) => Promise<{ config: OpenClawConfig; written: boolean }>;
export type SetupInferenceConfigWriteOptions = {
  writeOptions: ConfigWriteOptions;
  captureUndo: (undo: SetupInferenceConfigUndo) => void;
};
type SetupInferenceConfigWriter = (
  config: OpenClawConfig,
  options: SetupInferenceConfigWriteOptions,
) => Promise<OpenClawConfig>;
export type SetupInferenceConfigTarget = {
  write: SetupInferenceConfigWriter;
  read: () => Promise<{ config: OpenClawConfig; write: SetupInferenceConfigWriter }>;
};

export function setupConfigPatchConflicts(
  base: unknown,
  current: unknown,
  patch: unknown,
): boolean {
  if (!isRecord(patch)) {
    return !isDeepStrictEqual(base, current);
  }
  if (
    isRecord(base) !== isRecord(current) ||
    (!isRecord(base) && !isDeepStrictEqual(base, current))
  ) {
    return true;
  }
  const before = isRecord(base) ? base : {};
  const now = isRecord(current) ? current : {};
  return Object.entries(patch).some(([key, change]) =>
    setupConfigPatchConflicts(before[key], now[key], change),
  );
}

export function restoreSetupInferenceConfig(
  current: OpenClawConfig,
  before: OpenClawConfig,
  after: OpenClawConfig,
) {
  if (!setupConfigPatchConflicts(before, current, createMergePatch(before, after))) {
    return { config: current, written: false };
  }
  const reverse = createMergePatch(after, before);
  if (setupConfigPatchConflicts(after, current, reverse)) {
    throw new SetupInferenceOwnerDriftError(
      "Newer connection settings superseded this activation. Those settings were preserved.",
    );
  }
  // SAFETY: The inverse patch is derived from the writer's typed before/after configs.
  return { config: applyMergePatch(current, reverse) as OpenClawConfig, written: true };
}

/** Captures only this file writer's effects, before its guarded commit can start. */
export function captureSetupInferenceFileUndo(
  snapshot: ConfigFileSnapshot,
  candidate: OpenClawConfig,
): SetupInferenceConfigUndo {
  return async (writeOptions) => {
    const current = await readConfigFileSnapshot();
    if (current.path !== snapshot.path) {
      throw new SetupInferenceOwnerDriftError(
        "The configuration owner changed before activation recovery.",
      );
    }
    const restored = restoreSetupInferenceConfig(
      current.sourceConfig,
      snapshot.sourceConfig,
      candidate,
    );
    if (!restored.written) {
      return { config: current.runtimeConfig ?? current.config, written: false };
    }
    const committed = await transformConfigFileWithRetry({
      base: "source",
      writeOptions: copyRuntimeConfigWriteApplication(writeOptions, {
        ...writeOptions,
        expectedConfigPath: snapshot.path,
      }),
      transform: (config) => ({
        nextConfig: restoreSetupInferenceConfig(config, snapshot.sourceConfig, candidate).config,
      }),
    });
    return { config: committed.nextConfig, written: true };
  };
}

/** Setup coordinates effects; the selected config and auth owners retain their own undo. */
export async function commitSetupInferenceActivation(params: {
  preserveWorkingConnection?: boolean;
  configTarget: SetupInferenceConfigTarget;
  config: OpenClawConfig;
  activate: (assertCurrent: () => void) => Promise<SetupCredentialActivationReceipt | undefined>;
  assertCurrent: () => void;
  deferCompletion?: (complete: () => Promise<boolean>) => void;
}): Promise<OpenClawConfig> {
  const continuation = captureGatewayRootWorkAdmissionContinuationScope()?.run;
  let credential: SetupCredentialActivationReceipt | undefined;
  let undoConfig: SetupInferenceConfigUndo | undefined;
  let assertApplicationCurrent = params.assertCurrent;
  let activated = false;
  let configCommitted = false;
  const activate = async (assertCurrent: () => void) => {
    assertApplicationCurrent = assertCurrent;
    params.assertCurrent();
    assertCurrent();
    if (!activated) {
      credential = await params.activate(assertCurrent);
      activated = true;
    }
  };
  const application = params.deferCompletion
    ? createRuntimeConfigWriteApplication(continuation, {
        prepare: activate,
        requireImmediateApplication: params.preserveWorkingConnection,
      })
    : undefined;
  const restore = async () => {
    const restoredApplication = application
      ? createRuntimeConfigWriteApplication(continuation, {
          prepare: async (assertCurrent) => {
            assertApplicationCurrent = assertCurrent;
          },
        })
      : undefined;
    const restored =
      configCommitted && undoConfig
        ? await undoConfig(attachRuntimeConfigWriteApplication({}, restoredApplication))
        : { config: (await params.configTarget.read()).config, written: false };
    credential?.rollback();
    if (restoredApplication && restored.written) {
      if (!restoredApplication.claimed || (await restoredApplication.result) !== "applied") {
        throw new Error(
          "The previous connection was restored on disk, but the Gateway could not apply it. Restart the Gateway before chatting.",
        );
      }
    }
  };
  const recover = async (error: unknown): Promise<never> => {
    try {
      await restore();
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        `Activation failed and recovery could not complete. ${formatErrorMessage(recoveryError)}`,
        { cause: recoveryError },
      );
    }
    throw error;
  };
  let config: OpenClawConfig;
  try {
    config = await params.configTarget.write(params.config, {
      captureUndo: (undo) => {
        undoConfig = undo;
      },
      writeOptions: attachRuntimeConfigWriteApplication(
        {
          assertCurrent: params.assertCurrent,
          ...(application && params.preserveWorkingConnection
            ? {
                runtimeRefresh: { requireImmediateApplication: true },
              }
            : {}),
        },
        application,
      ),
    });
    configCommitted = true;
  } catch (error) {
    if (!credential) {
      throw error;
    }
    if (params.deferCompletion) {
      params.deferCompletion(async () => {
        if (application?.claimed) {
          await application.result;
        }
        return await recover(error);
      });
      throw error;
    }
    return await recover(error);
  }
  const complete = async (): Promise<boolean> => {
    try {
      if (application) {
        const status = application.claimed ? await application.result : "unclaimed";
        if (
          !params.preserveWorkingConnection &&
          (status === "restart-pending" || status === "applied-restart-required")
        ) {
          return true;
        }
        if (status !== "applied") {
          throw new Error(
            `The Gateway did not complete activation (${status}). Resolve the reported problem, then retry the saved sign-in.`,
          );
        }
      } else {
        await activate(params.assertCurrent);
      }
      params.assertCurrent();
      assertApplicationCurrent();
      credential?.assertCurrent();
      return false;
    } catch (error) {
      return await recover(error);
    }
  };
  if (params.deferCompletion) {
    params.deferCompletion(complete);
  } else {
    await complete();
  }
  return config;
}
