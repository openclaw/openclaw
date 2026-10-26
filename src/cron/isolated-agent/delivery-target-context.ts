import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { extractDeliveryInfoBatch } from "../../config/sessions/delivery-info.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { SessionEntrySummary } from "../../config/sessions/session-accessor.types.js";
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
  // Leave worker admission headroom for other session reads while listing large inventories.
  const { results: rows } = await runTasksWithConcurrency({
    limit: 8,
    tasks: [...targets].map(
      ({ agentId, storePath, threadSessionKey, mainSessionKey }) =>
        async (): Promise<Result<SessionEntrySummary[], unknown>> => {
          try {
            const result = await readSessionEntriesFromStoreInWorker({
              agentId,
              storePath,
              projection: "list",
              snapshotFields: [],
              sessionKeys: [threadSessionKey, mainSessionKey].flatMap((key) =>
                key ? [key].concat(foldedSessionKeyAliasCandidates(key)) : [],
              ),
            });
            return ok(result.entries);
          } catch (error) {
            return err(error);
          }
        },
    ),
  });
  const entries = new Map([...targets].map((plan, offset) => [plan, rows[offset]!]));
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
    const threadEntry = result?.value.find((row) => row.sessionKey === threadSessionKey)?.entry;
    const mainEntry = result?.value.find((row) => row.sessionKey === mainSessionKey)?.entry;
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
