import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../cron/normalize.js";
import type { GatewayCronServiceContract } from "../gateway/server-cron-contract.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import type { PluginHookGatewayCronService } from "./hook-types.js";
import { isPluginJsonValue } from "./host-hook-json.js";

export type PluginServiceCronHost = Pick<
  GatewayCronServiceContract,
  | "list"
  | "getJob"
  | "run"
  | "add"
  | "update"
  | "updateWithPrecondition"
  | "remove"
  | "removeStaleJobFamily"
>;

const TRIGGER_STATE_NAMESPACE_KEY = /^[A-Za-z][A-Za-z0-9]{0,127}$/;

function validateTriggerStateMutation(mutation: {
  key: string;
  expectedRevision: number;
  value: Record<string, unknown>;
}): void {
  if (
    !TRIGGER_STATE_NAMESPACE_KEY.test(mutation.key) ||
    !Number.isSafeInteger(mutation.expectedRevision) ||
    mutation.expectedRevision < 0 ||
    mutation.expectedRevision >= Number.MAX_SAFE_INTEGER ||
    !isRecord(mutation.value) ||
    !isPluginJsonValue(mutation.value) ||
    !Number.isSafeInteger(mutation.value.revision) ||
    mutation.value.revision !== mutation.expectedRevision + 1
  ) {
    throw new Error("Plugin service cron trigger state mutation is invalid");
  }
}

function createBoundPluginCronGetter(params: {
  getCron: () => PluginServiceCronHost | null | undefined;
  pluginId: string;
  assertActive: () => void;
}): () => PluginHookGatewayCronService | undefined {
  let cached: { cron: PluginServiceCronHost; service: PluginHookGatewayCronService } | undefined;
  return () => {
    params.assertActive();
    const cron = params.getCron();
    if (!cron) {
      return undefined;
    }
    if (cached?.cron === cron) {
      return cached.service;
    }
    const commitGuard = () => {
      params.assertActive();
      if (params.getCron() !== cron) {
        throw new Error("Plugin service cron scheduler was replaced");
      }
    };
    // A retained handle owns one scheduler. Recheck at the store lock, not only
    // before awaiting it, so replacement cannot admit an old queued write.
    const service: PluginHookGatewayCronService = {
      list: async (opts) => {
        commitGuard();
        const jobs = await cron.list(opts);
        commitGuard();
        return jobs;
      },
      getJob: (id) => {
        commitGuard();
        const job = cron.getJob(id);
        return job?.declarationKey?.startsWith(`${params.pluginId}:`) ? job : undefined;
      },
      run: async (id, mode, opts) => {
        const assertOwned = () => {
          commitGuard();
          const current = cron.getJob(id);
          if (!current?.declarationKey?.startsWith(`${params.pluginId}:`)) {
            throw new Error("Cron run is not owned by this plugin");
          }
          opts.commitGuard?.();
        };
        assertOwned();
        // The source job can change while admission waits for the store lock.
        // Recheck plugin ownership at commit so a stale wake cannot run another job.
        return await cron.run(id, mode, { evaluateTrigger: true, commitGuard: assertOwned });
      },
      add: async (input) => {
        commitGuard();
        const normalized = normalizeCronJobCreate(input);
        if (!normalized) {
          throw new Error("Plugin service cron create input is invalid");
        }
        return await cron.add(normalized, { commitGuard });
      },
      update: async (id, patch) => {
        commitGuard();
        const normalized = normalizeCronJobPatch(patch);
        if (!normalized) {
          throw new Error("Plugin service cron update input is invalid");
        }
        return await cron.update(id, normalized, { commitGuard });
      },
      mutateTriggerState: async (id, mutation) => {
        commitGuard();
        let capturedMutation: typeof mutation;
        try {
          capturedMutation = structuredClone(mutation);
        } catch {
          throw new Error("Plugin service cron trigger state mutation is invalid");
        }
        validateTriggerStateMutation(capturedMutation);
        const patch: Parameters<PluginServiceCronHost["updateWithPrecondition"]>[1] = {
          state: {},
        };
        return await cron.updateWithPrecondition(
          id,
          patch,
          (current) => {
            commitGuard();
            // The registration's manifest id is closure-bound. Checking the current row
            // under the store lock prevents a plugin from mutating another owner's state.
            if (!current.declarationKey?.startsWith(`${params.pluginId}:`)) {
              throw new Error("Cron trigger state mutation is not owned by this plugin");
            }
            const triggerState = current.state.triggerState;
            if (triggerState !== undefined && !isRecord(triggerState)) {
              throw new Error("Cron trigger state is not a namespace object");
            }
            const namespace = triggerState?.[capturedMutation.key];
            const currentRevision =
              namespace === undefined ? 0 : isRecord(namespace) ? namespace.revision : undefined;
            if (
              !Number.isSafeInteger(currentRevision) ||
              currentRevision !== capturedMutation.expectedRevision
            ) {
              throw new Error("Cron trigger state namespace revision conflict");
            }
            patch.state = {
              triggerState: {
                ...triggerState,
                [capturedMutation.key]: capturedMutation.value,
              },
            };
          },
          { commitGuard },
        );
      },
      remove: async (id) => {
        commitGuard();
        return await cron.remove(id, { commitGuard });
      },
      removeStaleJobFamily: async (family) => {
        commitGuard();
        return await cron.removeStaleJobFamily(family, { commitGuard });
      },
    };
    cached = { cron, service };
    return service;
  };
}

export function createPluginHookCronGetter(params: {
  getCron: () => PluginServiceCronHost | null | undefined;
  pluginId: string;
  assertActive: () => void;
}): () => PluginHookGatewayCronService | undefined {
  return createBoundPluginCronGetter(params);
}

export function createPluginServiceCronGetter(params: {
  getCron: () => PluginServiceCronHost | null | undefined;
  lease: PluginRuntimeCapabilityLease;
  pluginId: string;
  isStopping: () => boolean;
}): () => PluginHookGatewayCronService | undefined {
  return createBoundPluginCronGetter({
    getCron: params.getCron,
    pluginId: params.pluginId,
    assertActive: () => {
      params.lease.assertActive("cron scheduler");
      if (params.isStopping()) {
        throw new Error("Plugin service cron scheduler is stopping");
      }
    },
  });
}
