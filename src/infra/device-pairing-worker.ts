import { channel } from "node:diagnostics_channel";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { reserveWorkerEnvironmentNativePublication } from "../gateway/worker-environments/store-native-publication.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { clearDeviceAuthToken } from "./device-auth-store.js";
import type { DevicePairingAdmissionFacts } from "./device-pairing-admission.types.js";
import { invalidatePairedCardRendererCache } from "./device-pairing-card-renderer.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import { captureDevicePairingPublication } from "./device-pairing-publication.js";
import type { DevicePairingCommitReceipt } from "./device-pairing-read.types.js";
import { listDevicePairingStoreRecordsReadOnly } from "./device-pairing-store-readonly.js";
import type { DevicePairingWorkerOperations } from "./device-pairing-worker-contract.js";
import type { PairedDevice } from "./device-pairing.types.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";

const pairingDiagnostics = channel("openclaw.device-pairing.operation");
const pairingLog = createSubsystemLogger("gateway/device-pairing");

export const DevicePairingAuthorityRefusedError = resolveGlobalSingleton(
  Symbol.for("openclaw.devicePairingAuthorityRefusedError"),
  () =>
    class extends Error {
      constructor(message = "Device pairing authority changed") {
        super(message);
      }
    },
);

const setupChanges = resolveGlobalSingleton(
  Symbol.for("openclaw.devicePairSetupChanges"),
  () => new Set<(databasePath: string) => void>(),
);

export const onDevicePairSetupChange = (listener: (databasePath: string) => void) =>
  registerListener(setupChanges, listener);

// The broker owns this private channel; domain kernels supply the discriminated facts.
function admissionFacts(value: unknown): DevicePairingAdmissionFacts[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => isRecord(entry) && typeof entry.kind === "string")
  ) {
    throw new Error("Invalid pairing admission facts");
  }
  for (const entry of value) {
    if (
      (entry.kind === "bootstrap.cloudWorkerSetup" &&
        (typeof entry.environmentId !== "string" ||
          typeof entry.setupId !== "string" ||
          typeof entry.credentialDigest !== "string" ||
          typeof entry.provisionOperationId !== "string" ||
          typeof entry.ownerEpoch !== "number")) ||
      ((entry.kind === "bootstrap.consume" || entry.kind === "bootstrap.token") &&
        typeof entry.expiresAtMs !== "number")
    ) {
      throw new Error("Invalid pairing admission facts");
    }
  }
  // SAFETY: This private broker port only accepts the admitted backend's typed pairing facts.
  return value as DevicePairingAdmissionFacts[];
}

function commitReceipt(value: unknown): DevicePairingCommitReceipt {
  if (!isRecord(value) || value.kind !== "devicePairing") {
    throw new Error("Invalid pairing commit receipt");
  }
  // SAFETY: The private mutation worker builds this typed receipt after native COMMIT.
  return value as DevicePairingCommitReceipt;
}

export function executeDevicePairingMutation<Key extends keyof DevicePairingWorkerOperations>(
  command: { type: Key; input: DevicePairingWorkerOperations[Key]["input"] },
  options: {
    baseDir?: string;
    context?: OpenClawStateWorkerContext;
    assertCurrent?: () => void;
    admit?: (facts: DevicePairingAdmissionFacts) => void;
    onTokensReplaced?: (deviceId: string, roles: readonly string[]) => void;
    onNodeApproved?: (approval: NonNullable<DevicePairingCommitReceipt["nodeApproval"]>) => void;
    /** Map a refused operation only after its admission and publication have settled. */
    onAuthorityRefused?: () => DevicePairingWorkerOperations[Key]["output"];
  } = {},
): Promise<DevicePairingWorkerOperations[Key]["output"]> {
  const context =
    options.context ??
    captureOpenClawStateWorkerContext(
      options.baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: options.baseDir } } : {},
    );
  const captured = structuredClone(command);
  const credentialEnvironment = { ...process.env, ...context.environment };
  const startedAt = pairingDiagnostics.hasSubscribers ? performance.now() : undefined;
  let admittedAt = startedAt;
  let publicationMs = 0;
  const operation = withDevicePairingLock(async () => {
    if (startedAt !== undefined) {
      admittedAt = performance.now();
    }
    context.admission.assertCurrent();
    options.assertCurrent?.();
    // Join codes and retained setup cleanup cannot change paired-device authority.
    const publication =
      captured.type === "devicePairing.registerJoinCode" ||
      captured.type === "devicePairing.redeemJoinCode" ||
      captured.type === "bootstrap.prune"
        ? undefined
        : captureDevicePairingPublication(context.admission);
    const mutation = publication?.beginMutation();
    let admission: SqliteWorkerOperationAdmission | undefined;
    let published = false;
    let cacheCleanup: Promise<boolean> | undefined;
    let publishEnvironment: ReturnType<typeof reserveWorkerEnvironmentNativePublication>;
    const install = () => {
      if (!mutation) {
        return;
      }
      const committed = admission?.committed;
      if (committed && !published) {
        const publishingAt = startedAt === undefined ? undefined : performance.now();
        const receipt = commitReceipt(committed.facts);
        if (receipt.retiredNodeToken) {
          cacheCleanup = clearDeviceAuthToken({
            ...receipt.retiredNodeToken,
            role: "node",
            env: credentialEnvironment,
          }).catch((error: unknown) => {
            // Server revocation is committed. A failed cache cleanup cannot restore authority.
            pairingLog.warn(`Local retired node token cleanup failed: ${String(error)}`);
            return false;
          });
        }
        const environment = receipt.workerEnvironment;
        let environmentPublished = false;
        if (environment && publishEnvironment) {
          context.admission.assertCurrent();
          environmentPublished = publishEnvironment(environment.environmentId, {
            nodeDeviceId: environment.nodeDeviceId,
            updatedAtMs: environment.updatedAtMs,
          });
        }
        // A callback can throw or read publication recursively; the commit is already installed.
        published = true;
        mutation.publish(receipt);
        if (receipt.nodeApproval) {
          options.onNodeApproved?.(receipt.nodeApproval);
        }
        invalidatePairedCardRendererCache();
        if (environmentPublished) {
          sessionChanges.emit({ all: true, scope: "worker-environments" });
        }
        if (receipt.tokensReplaced) {
          options.onTokensReplaced?.(receipt.tokensReplaced.deviceId, receipt.tokensReplaced.roles);
        }
        if (publishingAt !== undefined) {
          publicationMs += performance.now() - publishingAt;
        }
      }
    };
    const removeService = publication?.servicePending(install);
    try {
      const result = await runOpenClawStateWorkerOperation(
        context,
        async (scope) => {
          try {
            return await scope.execute(captured);
          } finally {
            install();
          }
        },
        {
          assertCurrent: options.assertCurrent,
          createAdmission: () => {
            let committed = false;
            admission = createSqliteWorkerOperationAdmission((request, grant) => {
              if (committed || (request.stage !== "transaction" && request.stage !== "commit")) {
                throw new Error("Pairing admission requested out of order");
              }
              context.admission.assertCurrent();
              options.assertCurrent?.();
              for (const fact of admissionFacts(request.facts)) {
                options.admit?.(fact);
              }
              if (request.stage === "commit" && captured.type === "bootstrap.consume") {
                publishEnvironment = reserveWorkerEnvironmentNativePublication(
                  context.admission.identity,
                );
              }
              if (!grant()) {
                throw new DevicePairingAuthorityRefusedError();
              }
              committed = request.stage === "commit";
            });
            return { admission, nativeLocations: [context.admission.databasePath] };
          },
        },
      );
      await cacheCleanup;
      return result;
    } finally {
      try {
        install();
      } finally {
        mutation?.finish(!admission || admission.settlement?.kind === "completed");
        removeService?.();
        // Unknown outcomes can have committed; retry discovery without reviving authority.
        if (
          captured.type === "bootstrap.consume" ||
          captured.type === "bootstrap.confirm" ||
          captured.type === "bootstrap.ensure" ||
          captured.type === "bootstrap.readCompletion"
        ) {
          notifyListeners(setupChanges, context.admission.databasePath);
        }
      }
    }
  });
  if (startedAt !== undefined) {
    const report = () =>
      pairingDiagnostics.publish({
        operation: captured.type,
        queueMs: admittedAt! - startedAt,
        durationMs: performance.now() - admittedAt!,
        publicationMs,
      });
    void operation.then(report, report);
  }
  const onAuthorityRefused = options.onAuthorityRefused;
  return onAuthorityRefused
    ? operation.catch((error: unknown) => {
        if (error instanceof DevicePairingAuthorityRefusedError) {
          return onAuthorityRefused();
        }
        throw error;
      })
    : operation;
}

/** Start the privileged effect in the same interval that publishes its pairing facts. */
export async function withCurrentDevicePairingSnapshot<T>(
  baseDir: string | undefined,
  prepare: (paired: readonly PairedDevice[]) => { start: () => T | Promise<T> } | undefined,
  preparePublication?: () => Promise<void>,
): Promise<T | undefined> {
  const begun = await withDevicePairingLock(async () => {
    const { paired } = await listDevicePairingStoreRecordsReadOnly(baseDir, true);
    if (preparePublication) {
      await preparePublication();
    }
    const action = prepare(paired);
    return { value: action?.start() };
  });
  return begun.value;
}
