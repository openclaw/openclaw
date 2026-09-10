import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { extractDeliveryInfoBatch } from "../../config/sessions/delivery-info.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadExactSessionEntryCandidatesReadOnlyBatch } from "../../config/sessions/session-accessor.js";
import { foldedSessionKeyAliasCandidates } from "../../config/sessions/store-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
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

/** Prepare owned delivery facts synchronously; no database or borrowed view survives the read. */
export function readCronDeliveryTargetContexts(
  cfg: OpenClawConfig,
  requests: readonly CronDeliveryContextRequest[],
): Array<Result<CronDeliveryTargetContext, unknown>> {
  const planned = requests.map(({ agentId, sessionKey }): Result<CronDeliveryReadPlan, unknown> => {
    try {
      const rawSessionKey = sessionKey?.trim();
      return ok({
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
      });
    } catch (error) {
      return err(error);
    }
  });
  const recovered = extractDeliveryInfoBatch(
    planned.map((item) => (item.ok ? item.value.threadSessionKey : undefined)),
    { cfg },
  );
  const readKey = (agentId: string, storePath: string, sessionKey: string) =>
    JSON.stringify([agentId, storePath, sessionKey]);
  const reads = new Map<string, { agentId: string; storePath: string; sessionKey: string }>();
  for (const item of planned) {
    if (!item.ok) {
      continue;
    }
    const { agentId, storePath, mainSessionKey, threadSessionKey } = item.value;
    for (const sessionKey of [threadSessionKey, mainSessionKey]) {
      if (sessionKey) {
        reads.set(readKey(agentId, storePath, sessionKey), { agentId, storePath, sessionKey });
      }
    }
  }
  const scopes = [...reads.values()];
  const rows = loadExactSessionEntryCandidatesReadOnlyBatch(
    scopes.map((scope) => ({
      agentId: scope.agentId,
      storePath: scope.storePath,
      projection: "list",
      // Cron's main/thread resolvers already produce canonical store keys. Retain
      // the scalar reader's folded-candidate validation and SQLite key ordering.
      sessionKeys: [
        scope.sessionKey,
        ...foldedSessionKeyAliasCandidates(scope.sessionKey),
      ].toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
    })),
  );
  const entries = new Map(
    [...reads.keys()].map((key, index) => {
      const result = rows[index]!;
      return [
        key,
        result.ok
          ? ok(result.value.find((entry) => entry.sessionKey === scopes[index]!.sessionKey)?.entry)
          : result,
      ] as const;
    }),
  );
  const readEntry = (agentId: string, storePath: string, sessionKey: string) => {
    const result = entries.get(readKey(agentId, storePath, sessionKey))!;
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  };
  return planned.map((item, index) => {
    if (!item.ok) {
      return item;
    }
    const { agentId, storePath, mainSessionKey, rawSessionKey, threadSessionKey } = item.value;
    try {
      const recoveredInfo = recovered[index];
      const recoveredContext = recoveredInfo?.deliveryContext;
      const context =
        recoveredContext && recoveredInfo?.threadId
          ? { ...recoveredContext, threadId: recoveredInfo.threadId }
          : recoveredContext;
      const threadEntry = threadSessionKey
        ? readEntry(agentId, storePath, threadSessionKey)
        : undefined;
      const mainEntry = readEntry(agentId, storePath, mainSessionKey);
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
    } catch (error) {
      return err(error);
    }
  });
}
