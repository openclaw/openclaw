import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { tryParseJsonObject } from "../cron/store/scalar-codec.js";
import { formatErrorMessage } from "../infra/errors.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { OpenClawConfig } from "./types.js";

type CronOwnerRefusalDeps = Pick<
  typeof import("../infra/gateway-lock.js"),
  "readActiveGatewayLockIdentity"
> &
  Pick<typeof import("../commands/doctor/cron/legacy-repair.js"), "loadLegacyCronRepairState">;
const RETRY = ' Run "openclaw doctor --fix", then retry.';
const CRON_OWNER_REFUSAL = "cron-owner-safety";

export function createCronOwnerWriteRefusalError(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: "CONFIG_WRITE_REJECTED",
    refusal: CRON_OWNER_REFUSAL,
  });
}

export function isCronOwnerWriteRefusalError(error: unknown): error is Error {
  return error instanceof Error && "refusal" in error && error.refusal === CRON_OWNER_REFUSAL;
}

function hasOwner(record: Record<string, unknown> | null | undefined): boolean {
  if (!record) {
    return false;
  }
  return Boolean(
    normalizeOptionalString(record.agentId) ||
    parseAgentSessionKey(normalizeOptionalString(record.sessionKey))?.agentId,
  );
}

async function loadDefaultDeps(): Promise<CronOwnerRefusalDeps> {
  const [{ readActiveGatewayLockIdentity }, { loadLegacyCronRepairState }] = await Promise.all([
    import("../infra/gateway-lock.js"),
    import("../commands/doctor/cron/legacy-repair.js"),
  ]);
  return {
    readActiveGatewayLockIdentity,
    loadLegacyCronRepairState,
  };
}

async function assertSafe(
  cfg: OpenClawConfig,
  storePath: string,
  env: NodeJS.ProcessEnv,
  deps: CronOwnerRefusalDeps,
  provenOwnerAgentId?: string,
): Promise<void> {
  const active = await deps.readActiveGatewayLockIdentity({ env }).catch((error: unknown) => {
    throw createCronOwnerWriteRefusalError(
      `Config write refused: cannot inspect the Gateway lock (${formatErrorMessage(error)}).${RETRY}`,
      error,
    );
  });
  const state = await deps
    .loadLegacyCronRepairState({ cfg, storePath, env, readOnly: true })
    .catch((error: unknown) => {
      throw createCronOwnerWriteRefusalError(
        `Config write refused: cannot inspect cron ownership at ${storePath} (${formatErrorMessage(error)}).${RETRY}`,
        error,
      );
    });
  let unresolved = 0;
  let projectedDynamicDefaults = 0;
  for (const job of state?.rawJobs ?? []) {
    if (hasOwner(job)) {
      continue;
    }
    const id = normalizeOptionalString(job.id) ?? normalizeOptionalString(job.jobId);
    const projection = id ? state?.projectedOwnersByJobId.get(id) : undefined;
    if (!projection || projection.kind === "unresolved") {
      unresolved += 1;
    } else if (projection.kind === "runtime-default") {
      projectedDynamicDefaults += 1;
    }
  }
  const unverifiable = state?.invalidConfigRows?.length ?? 0;
  if (unverifiable > 0) {
    throw createCronOwnerWriteRefusalError(
      `Config write refused: cron store ${storePath} contains ${unverifiable} corrupt row(s) whose ownership cannot be verified.${RETRY}`,
    );
  }
  const sqlOnlyOwners =
    state?.ownerRows.filter(
      (row) => normalizeOptionalString(row.agent_id) && !hasOwner(tryParseJsonObject(row.job_json)),
    ).length ?? 0;
  const requiresRepair =
    unresolved + (provenOwnerAgentId ? projectedDynamicDefaults + sqlOnlyOwners : 0);
  if (requiresRepair > 0) {
    throw createCronOwnerWriteRefusalError(
      `Config write refused: cron store ${storePath} contains ${requiresRepair} ownerless legacy cron job(s).${RETRY}`,
    );
  }
  if (active && active.pid !== process.pid && active.cronOwnerProjection !== "dynamic-default-v1") {
    throw createCronOwnerWriteRefusalError(
      `Config write refused: live external Gateway pid ${active.pid} does not prove compatibility with the current cron ownership projection. Restart it with this OpenClaw version, or stop it, then retry.`,
    );
  }
}

export async function prepareCronOwnerWriteRefusal(
  cfg: OpenClawConfig,
  params: {
    storePath: string;
    provenOwnerAgentId?: string;
    env?: NodeJS.ProcessEnv;
  },
  injectedDeps?: CronOwnerRefusalDeps,
): Promise<{ recheck: () => Promise<void> }> {
  const env = params.env ?? process.env;
  const deps = injectedDeps ?? (await loadDefaultDeps());
  const recheck = () => assertSafe(cfg, params.storePath, env, deps, params.provenOwnerAgentId);
  await recheck();
  return { recheck };
}
