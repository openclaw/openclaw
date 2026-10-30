import type {
  CronModelImpactJob,
  CronModelImpactParams,
  CronModelImpactResult,
  CronModelImpactSelection,
} from "../../packages/gateway-protocol/src/schema/cron-model-impact.js";
import { listAgentIds, resolveAgentConfig } from "../agents/agent-scope-config.js";
import type { RuntimeAuthMaterialization } from "../agents/auth-profiles/runtime-materializations.js";
import type { ResolvedPublishedModelCatalogOwner } from "../agents/prepared-model-catalog.types.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import { toAgentModelListLike } from "../config/model-input.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveHookExternalContentSource } from "../security/external-content-source.js";
import { tryResolveCronJobEffectiveAgentId } from "./agent-id.js";
import { resolveCronModelSelection } from "./isolated-agent/model-selection.js";
import { resolveCarriedCronModelSelection } from "./isolated-agent/session-carried-model.js";
import { assessCronModelCompatibility } from "./model-impact-compatibility.js";
import type { CronStoredJob } from "./types.js";

const unresolved: CronModelImpactSelection = { model: null, source: null };
export type CronModelImpactSession = { entry?: SessionEntry; available: boolean };
export type CronModelImpactOwner = ResolvedPublishedModelCatalogOwner & {
  authMaterializations?: readonly RuntimeAuthMaterialization[];
};

/** A proposed primary is a private value, never an activated runtime or config write. */
export function deriveCronModelImpactConfig(
  cfg: OpenClawConfig,
  input: CronModelImpactParams,
): OpenClawConfig {
  const agentId = input.agentId?.trim();
  if (agentId && !listAgentIds(cfg).includes(agentId)) {
    throw new TypeError("Unknown agentId for automation model preview");
  }
  const model = input.model === null ? null : input.model.trim();
  if (model === "") {
    throw new TypeError("Model must be nonblank, or null to clear the primary");
  }
  const current = agentId ? cfg.agents?.entries?.[agentId]?.model : cfg.agents?.defaults?.model;
  const next = { ...toAgentModelListLike(current) };
  if (model === null) {
    delete next.primary;
  } else {
    next.primary = model;
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      ...(agentId
        ? {
            entries: {
              ...cfg.agents?.entries,
              [agentId]: { ...cfg.agents?.entries?.[agentId], model: next },
            },
          }
        : { defaults: { ...cfg.agents?.defaults, model: next } }),
    },
  };
}

function carriedEntry(job: CronStoredJob, entry: SessionEntry | undefined): Partial<SessionEntry> {
  if (job.sessionTarget === "current" && job.inferenceBinding?.runtime) {
    return {};
  }
  return entry && (job.sessionTarget === "isolated" || job.sessionTarget === "current")
    ? resolveCarriedCronModelSelection(entry)
    : (entry ?? {});
}

/** Both detached and ordinary scheduled agent turns use resolveCronModelSelection at execution. */
async function select(params: {
  cfg: OpenClawConfig;
  owner: CronModelImpactOwner;
  job: CronStoredJob;
  session: CronModelImpactSession;
}) {
  const { cfg, job, owner } = params;
  const entry = carriedEntry(job, params.session.entry);
  if (job.payload.kind === "systemEvent") {
    const ref = resolveSessionModelRef(cfg, entry, owner.agentId, {
      allowPluginNormalization: false,
    });
    return {
      ok: true as const,
      provider: ref.provider,
      model: ref.model,
      modelSource: entry.modelOverride
        ? ("session" as const)
        : resolveAgentConfig(cfg, owner.agentId)?.model
          ? ("agent" as const)
          : ("default" as const),
      cfgWithAgentDefaults: cfg,
      configuredProfileId: undefined,
    };
  }
  return resolveCronModelSelection({
    cfg,
    owner: { ...owner, config: cfg },
    agentId: owner.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    agentConfigOverride: resolveAgentConfig(cfg, owner.agentId),
    sessionEntry: entry,
    payloadModel: job.payload.kind === "agentTurn" ? job.payload.model : undefined,
    isGmailHook:
      (job.payload.kind === "agentTurn" ? job.payload.externalContentSource : undefined) ===
        "gmail" ||
      resolveHookExternalContentSource(
        job.sessionTarget === "current" ? (job.sessionKey ?? "") : "cron:" + job.id,
      ) === "gmail",
  });
}

function publicSelection(selection: Awaited<ReturnType<typeof select>>): CronModelImpactSelection {
  return selection.ok
    ? { model: selection.provider + "/" + selection.model, source: selection.modelSource }
    : unresolved;
}

/** Read-only composition of scheduler selection and prepared account/runtime decisions. */
export async function resolveCronModelImpact(params: {
  cfg: OpenClawConfig;
  input: CronModelImpactParams;
  jobs: readonly CronStoredJob[];
  defaultAgentId?: string;
  ownerForAgent: (agentId: string) => CronModelImpactOwner | undefined;
  readSession: (job: CronStoredJob, agentId: string) => Promise<CronModelImpactSession>;
}): Promise<CronModelImpactResult> {
  const proposed = deriveCronModelImpactConfig(params.cfg, params.input);
  const jobs: CronModelImpactJob[] = [];
  for (const job of params.jobs) {
    const agentId = tryResolveCronJobEffectiveAgentId(job, params.defaultAgentId);
    const row: CronModelImpactJob = {
      id: job.id,
      name: job.name,
      enabled: job.enabled,
      effectiveAgentId: agentId ?? null,
      before: unresolved,
      after: unresolved,
      changed: false,
      status: "unknown",
      issues: [],
    };
    jobs.push(row);
    if (
      job.pluginCommand ||
      (job.payload.kind !== "agentTurn" && job.payload.kind !== "systemEvent")
    ) {
      row.status = "not-applicable";
      continue;
    }
    const owner = agentId ? params.ownerForAgent(agentId) : undefined;
    if (!owner) {
      row.issues.push({
        code: "model-owner-unavailable",
        severity: "warning",
        message:
          "The execution agent's prepared model metadata is unavailable. Refresh after agent preparation completes.",
      });
      continue;
    }
    const session = await params.readSession(job, owner.agentId);
    // A missing row is a known fresh session; a failed read is not evidence of no override.
    if (!session.available) {
      row.issues.push({
        code: "session-selection-unavailable",
        severity: "warning",
        message:
          "The execution session's model selection could not be read. Preview cannot exclude an intentional session selection.",
      });
      continue;
    }
    const before = await withPluginRuntimeGenerationScope(owner, () =>
      select({ cfg: params.cfg, owner, job, session }),
    );
    const after = await withPluginRuntimeGenerationScope(owner, () =>
      select({ cfg: proposed, owner, job, session }),
    );
    row.before = publicSelection(before);
    row.after = publicSelection(after);
    row.changed = row.before.model !== row.after.model;
    if (!after.ok) {
      // Resolver errors may contain authored profile suffixes. Keep public diagnostics bounded to policy guidance.
      row.issues.push({
        code: "model-selection-rejected",
        severity: "blocker",
        message:
          "The automation's selected model is rejected by its execution agent's model policy or cannot be resolved.",
        recovery:
          "Inspect the automation's model selection and its agent's modelPolicy.allow. Select an allowed model; preview does not change policy.",
      });
    } else {
      row.issues.push(
        ...assessCronModelCompatibility({
          cfg: proposed,
          owner,
          job,
          provider: after.provider,
          model: after.model,
          sessionEntry: carriedEntry(job, session.entry),
          configuredProfileId: after.configuredProfileId,
        }),
      );
    }
    row.status = row.issues.some((issue) => issue.severity === "blocker")
      ? "blocked"
      : row.issues.some((issue) => issue.severity === "warning")
        ? "unknown"
        : "no-known-blocker";
  }
  return {
    model: params.input.model === null ? null : params.input.model.trim(),
    ...(params.input.agentId ? { agentId: params.input.agentId.trim() } : {}),
    jobs,
    issues: [
      {
        code: "metadata-only-preview",
        severity: "info",
        message:
          "Preview uses current prepared metadata. It does not verify upstream connectivity, credential acceptance, authorization lifetime, fallback outcomes, tools, or delivery. No jobs or accounts are changed; expired work is not replayed.",
      },
    ],
  };
}
