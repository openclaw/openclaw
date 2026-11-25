import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { extractDeliveryInfoBatch } from "../../config/sessions/delivery-info.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { readSessionEntriesFromStoreInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { foldedSessionKeyAliasCandidates } from "../../config/sessions/store-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { resolveCronAgentSessionKey } from "./session-key.js";

export type CronDeliveryContextRequest = { agentId: string; sessionKey?: string };

export type CronDeliveryTargetContext = {
  mainSessionKey: string;
  rawSessionKey?: string;
  threadSessionKey?: string;
  main?: SessionEntry;
  usedSharedMainFallback: boolean;
};

type CronDeliveryReadPlan = Omit<CronDeliveryTargetContext, "main" | "usedSharedMainFallback"> & {
  agentId: string;
  storePath: string;
};

/** Prepare owned delivery facts through the session worker; no borrowed view survives the read. */
export async function readCronDeliveryTargetContexts(
  cfg: OpenClawConfig,
  requests: readonly CronDeliveryContextRequest[],
): Promise<Array<Result<CronDeliveryTargetContext, unknown>>> {
  const readPlans = new Map<string, CronDeliveryReadPlan>();
  const planned = requests.map(({ agentId, sessionKey }): Result<CronDeliveryReadPlan, unknown> => {
    try {
      const rawSessionKey = sessionKey?.trim();
      // Identical targets share preparation only within this request, never across route changes.
      const key = JSON.stringify([agentId, rawSessionKey]);
      let plan = readPlans.get(key);
      if (!plan) {
        plan = {
          agentId,
          rawSessionKey,
          mainSessionKey: resolveAgentMainSessionKey({ cfg, agentId }),
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
          threadSessionKey: rawSessionKey
            ? resolveCronAgentSessionKey({
                sessionKey: rawSessionKey,
                agentId,
                mainKey: cfg.session?.mainKey,
                cfg,
              })
            : undefined,
        };
        readPlans.set(key, plan);
      }
      return ok(plan);
    } catch (error) {
      return err(error);
    }
  });
  const recovered = await extractDeliveryInfoBatch(
    planned.map((item) =>
      item.ok ? { sessionKey: item.value.threadSessionKey, agentId: item.value.agentId } : {},
    ),
    { cfg },
  );
  const targets = new Set<CronDeliveryReadPlan>();
  for (const [index, item] of planned.entries()) {
    if (item.ok && !recovered[index]?.deliveryContext) {
      targets.add(item.value);
    }
  }
  const batches = new Map<string, CronDeliveryReadPlan[]>();
  for (const plan of targets) {
    const key = JSON.stringify([plan.agentId, plan.storePath]);
    const batch = batches.get(key);
    if (batch) {
      batch.push(plan);
    } else {
      batches.set(key, [plan]);
    }
  }
  type Entries = Result<Map<string, SessionEntry>, unknown>;
  const read = async (plans: CronDeliveryReadPlan[]): Promise<Entries> => {
    const { agentId, storePath } = plans[0]!;
    try {
      const result = await readSessionEntriesFromStoreInWorker({
        agentId,
        storePath,
        projection: "list",
        snapshotFields: [],
        sessionKeys: [
          ...new Set(
            plans.flatMap(({ threadSessionKey, mainSessionKey }) =>
              [threadSessionKey, mainSessionKey].flatMap((key) =>
                key ? [key].concat(foldedSessionKeyAliasCandidates(key)) : [],
              ),
            ),
          ),
        ],
      });
      return ok(new Map(result.entries.map(({ sessionKey, entry }) => [sessionKey, entry])));
    } catch (error) {
      return err(error);
    }
  };
  const entries = new Map<CronDeliveryReadPlan, Entries>();
  // Leave worker admission headroom for other session reads while listing large inventories.
  await runTasksWithConcurrency({
    limit: 8,
    tasks: [...batches.values()].map((batch) => async () => {
      const result = await read(batch);
      for (const plan of batch) {
        // One unreadable target must not suppress healthy targets in the same store.
        entries.set(plan, !result.ok && batch.length > 1 ? await read([plan]) : result);
      }
    }),
  });
  return planned.map((item, index) => {
    if (!item.ok) {
      return item;
    }
    const { mainSessionKey, rawSessionKey, threadSessionKey } = item.value;
    const recoveredInfo = recovered[index];
    const recoveredContext = recoveredInfo?.deliveryContext;
    const context =
      recoveredContext && recoveredInfo?.threadId
        ? { ...recoveredContext, threadId: recoveredInfo.threadId }
        : recoveredContext;
    const result = context ? undefined : entries.get(item.value);
    if (result && !result.ok) {
      return result;
    }
    const threadEntry = threadSessionKey ? result?.value.get(threadSessionKey) : undefined;
    const mainEntry = result?.value.get(mainSessionKey);
    const selected = threadEntry ?? mainEntry;
    return ok({
      mainSessionKey,
      rawSessionKey,
      threadSessionKey,
      // Retain only the fields consumed by session delivery resolution, including
      // the distinction between an absent entry and one without a route.
      main:
        context || selected
          ? {
              sessionId: context ? (threadSessionKey ?? mainSessionKey) : selected!.sessionId,
              updatedAt: context ? 0 : selected!.updatedAt,
              delivery: context
                ? normalizeSessionDeliveryState({ context })
                : structuredClone(selected?.delivery),
            }
          : undefined,
      usedSharedMainFallback: !context && !threadEntry && mainEntry !== undefined,
    });
  });
}
