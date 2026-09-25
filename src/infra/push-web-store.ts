import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import {
  WebPushSubscriptionBindingError,
  type WebPushMutationGuard,
} from "./push-web-store.records.js";
import {
  runWebPushStoreMutation,
  useWebPushStoreSnapshot,
  type WebPushSnapshotAction,
} from "./push-web-store.scope.js";
import type { WebPushWorkerOperations } from "./push-web-store.worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
export {
  WebPushSubscriptionBindingError,
  createWebPushVapidKeyPair,
  hashWebPushEndpoint,
  isValidWebPushEndpoint,
  isValidWebPushKey,
  DEFAULT_WEB_PUSH_VAPID_SUBJECT,
  type WebPushSubscription,
  type BoundWebPushSubscription,
  type VapidKeyPair,
  type WebPushMutationGuard,
} from "./push-web-store.records.js";

const loadNativeWebPushStore = createLazyRuntimeModule(() => import("./push-web-store.native.js"));

function context(stateDir?: string) {
  const env = cloneEnvWithPlatformSemantics(process.env);
  if (stateDir) {
    env.OPENCLAW_STATE_DIR = stateDir;
  }
  return captureOpenClawStateWorkerContext({ env });
}

function executeWorkerWebPushMutation<
  Type extends
    | "webPush.setWebPushSubscriptionPreferences"
    | "webPush.upsertWebPushSubscription"
    | "webPush.deleteBoundWebPushSubscription",
>(
  type: Type,
  input: WebPushWorkerOperations[Type]["input"],
  captured: OpenClawStateWorkerContext,
  guard: Extract<WebPushMutationGuard, { family: "worker" }> | undefined,
) {
  return runOpenClawStateWorkerOperation(
    captured,
    (scope) =>
      scope.execute({
        type,
        input: { ...input, requestProfiles: guard?.profiles },
      }),
    {
      assertCurrent: guard?.assertCurrent,
      createAdmission: () => ({
        nativeLocations: [captured.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction") {
            throw new Error("Web Push mutation requires transaction admission");
          }
          captured.admission.assertCurrent();
          guard?.assertCurrent();
          if (guard) {
            const facts = request.facts;
            if (
              !isRecord(facts) ||
              (facts.profileId !== null && typeof facts.profileId !== "string") ||
              typeof facts.bindingCurrent !== "boolean"
            ) {
              throw new Error("Web Push mutation profile facts are invalid");
            }
            guard.assertProfiles({
              profileId: facts.profileId,
              bindingCurrent: facts.bindingCurrent,
            });
          }
          grant();
        }),
      }),
    },
  );
}

export function withBoundWebPushSubscriptionByEndpoint<T>(
  params: WebPushWorkerOperations["webPush.findBoundWebPushSubscriptionByEndpoint"]["input"] & {
    stateDir?: string;
  },
  prepare: (
    subscription: WebPushWorkerOperations["webPush.findBoundWebPushSubscriptionByEndpoint"]["output"],
  ) => WebPushSnapshotAction<T> | undefined,
) {
  const { stateDir, ...input } = params;
  const captured = context(stateDir);
  return useWebPushStoreSnapshot(
    captured,
    input,
    () =>
      executeOpenClawStateWorker(captured, {
        type: "webPush.findBoundWebPushSubscriptionByEndpoint",
        input,
      }),
    prepare,
  );
}

export function withBoundWebPushSubscriptions<T>(
  stateDir: string | undefined,
  prepare: (
    subscriptions: WebPushWorkerOperations["webPush.listBoundWebPushSubscriptions"]["output"],
    assertCurrent: () => void,
  ) => WebPushSnapshotAction<T> | undefined | Promise<WebPushSnapshotAction<T> | undefined>,
) {
  const captured = context(stateDir);
  return useWebPushStoreSnapshot(
    captured,
    undefined,
    () =>
      executeOpenClawStateWorker(captured, {
        type: "webPush.listBoundWebPushSubscriptions",
        input: undefined,
      }),
    prepare,
  );
}

export function withWebPushSubscriptions<T>(
  stateDir: string | undefined,
  prepare: (
    subscriptions: WebPushWorkerOperations["webPush.listWebPushSubscriptions"]["output"],
  ) => WebPushSnapshotAction<T> | undefined,
) {
  const captured = context(stateDir);
  return useWebPushStoreSnapshot(
    captured,
    undefined,
    () =>
      executeOpenClawStateWorker(captured, {
        type: "webPush.listWebPushSubscriptions",
        input: undefined,
      }),
    prepare,
  );
}

export async function setWebPushSubscriptionPreferences(
  params: WebPushWorkerOperations["webPush.setWebPushSubscriptionPreferences"]["input"] & {
    stateDir?: string;
    guard?: WebPushMutationGuard;
  },
) {
  const { stateDir, guard, ...input } = params;
  const captured = context(stateDir);
  return runWebPushStoreMutation(captured, input, async () => {
    if (guard?.family === "native-compatibility") {
      const store = await loadNativeWebPushStore();
      return store.setNativeWebPushSubscriptionPreferences(
        { ...input, assertCurrent: guard.assertCurrent },
        captured,
      );
    }
    return executeWorkerWebPushMutation(
      "webPush.setWebPushSubscriptionPreferences",
      input,
      captured,
      guard,
    );
  });
}

export function listWebPushSubscriptions(stateDir?: string) {
  return executeOpenClawStateWorker(context(stateDir), {
    type: "webPush.listWebPushSubscriptions",
    input: undefined,
  });
}

export function hasBoundWebPushSubscriptions(stateDir?: string) {
  return executeOpenClawStateWorker(context(stateDir), {
    type: "webPush.hasBoundWebPushSubscriptions",
    input: undefined,
  });
}

export function listBoundWebPushSubscriptions(stateDir?: string) {
  return executeOpenClawStateWorker(context(stateDir), {
    type: "webPush.listBoundWebPushSubscriptions",
    input: undefined,
  });
}

export function prepareWebPushApprovalDeliveries(
  params: WebPushWorkerOperations["webPush.prepareWebPushApprovalDeliveries"]["input"] & {
    stateDir?: string;
  },
) {
  if (params.subscriptions.length === 0) {
    return Promise.resolve<string[]>([]);
  }
  const { stateDir, ...input } = params;
  return executeOpenClawStateWorker(context(stateDir), {
    type: "webPush.prepareWebPushApprovalDeliveries",
    input,
  });
}

export function listWebPushApprovalDeliveryTargets(
  params: WebPushWorkerOperations["webPush.listWebPushApprovalDeliveryTargets"]["input"] & {
    stateDir?: string;
  },
) {
  const { stateDir, ...input } = params;
  return executeOpenClawStateWorker(context(stateDir), {
    type: "webPush.listWebPushApprovalDeliveryTargets",
    input,
  });
}

export function deleteWebPushApprovalDeliveryTargets(
  params: WebPushWorkerOperations["webPush.deleteWebPushApprovalDeliveryTargets"]["input"] & {
    stateDir?: string;
  },
) {
  if (params.subscriptionIds.length === 0) {
    return Promise.resolve();
  }
  const { stateDir, ...input } = params;
  return executeOpenClawStateWorker(context(stateDir), {
    type: "webPush.deleteWebPushApprovalDeliveryTargets",
    input,
  });
}

export function listTerminalWebPushApprovalDeliveryIds(
  params: WebPushWorkerOperations["webPush.listTerminalWebPushApprovalDeliveryIds"]["input"] & {
    stateDir?: string;
  },
) {
  const { stateDir, ...input } = params;
  return executeOpenClawStateWorker(context(stateDir), {
    type: "webPush.listTerminalWebPushApprovalDeliveryIds",
    input,
  });
}

export async function upsertWebPushSubscription(
  params: WebPushWorkerOperations["webPush.upsertWebPushSubscription"]["input"] & {
    stateDir?: string;
    guard?: WebPushMutationGuard;
  },
) {
  const { stateDir, guard, ...input } = params;
  const captured = context(stateDir);
  return runWebPushStoreMutation(captured, input, async () => {
    if (guard?.family === "native-compatibility") {
      const store = await loadNativeWebPushStore();
      return store.upsertNativeWebPushSubscription(
        { ...input, assertCurrent: guard.assertCurrent },
        captured,
      );
    }
    const result = await executeWorkerWebPushMutation(
      "webPush.upsertWebPushSubscription",
      input,
      captured,
      guard,
    );
    if (result.bindingError !== undefined) {
      throw new WebPushSubscriptionBindingError(result.bindingError);
    }
    return result.subscription;
  });
}

export async function deleteBoundWebPushSubscription(
  params: WebPushWorkerOperations["webPush.deleteBoundWebPushSubscription"]["input"] & {
    stateDir?: string;
    guard?: WebPushMutationGuard;
  },
) {
  const { stateDir, guard, ...input } = params;
  const captured = context(stateDir);
  return runWebPushStoreMutation(captured, input, async () => {
    if (guard?.family === "native-compatibility") {
      const store = await loadNativeWebPushStore();
      return store.deleteNativeBoundWebPushSubscription(
        { ...input, assertCurrent: guard.assertCurrent },
        captured,
      );
    }
    return executeWorkerWebPushMutation(
      "webPush.deleteBoundWebPushSubscription",
      input,
      captured,
      guard,
    );
  });
}

export function deleteWebPushSubscriptionIfCurrent(
  params: WebPushWorkerOperations["webPush.deleteWebPushSubscriptionIfCurrent"]["input"] & {
    stateDir?: string;
  },
) {
  const { stateDir, ...input } = params;
  const captured = context(stateDir);
  return runWebPushStoreMutation(captured, input, () =>
    executeOpenClawStateWorker(captured, {
      type: "webPush.deleteWebPushSubscriptionIfCurrent",
      input,
    }),
  );
}

export async function readPersistedVapidKeyPair(stateDir?: string) {
  return (
    (await runOpenClawStateWorkerOperation(
      context(stateDir),
      (scope) =>
        scope.execute({
          type: "webPush.readPersistedVapidKeyPair",
          input: undefined,
        }),
      { existingOnly: true },
    )) ?? null
  );
}

export function insertVapidKeyPairIfAbsent(
  params: WebPushWorkerOperations["webPush.insertVapidKeyPairIfAbsent"]["input"] & {
    stateDir?: string;
  },
) {
  const { stateDir, ...input } = params;
  return executeOpenClawStateWorker(context(stateDir), {
    type: "webPush.insertVapidKeyPairIfAbsent",
    input,
  });
}
