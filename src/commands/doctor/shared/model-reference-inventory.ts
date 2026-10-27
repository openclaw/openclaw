import {
  collectConfiguredModelRefs,
  visitModelSelectorRefs,
} from "@openclaw/model-catalog-core/configured-model-refs";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds } from "../../../agents/agent-scope.js";
import { scanDoctorSessionEntriesTolerant } from "../../../config/sessions/session-accessor.js";
import {
  resolveAllAgentSessionStoreTargetsSync,
  resolveConfiguredAgentDatabaseTargets,
} from "../../../config/sessions/targets.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createRetainedAgentDatabaseMatcher } from "../../../state/agent-deletion-discovery.js";
import { readCronStoreSelectionForDoctor } from "../cron/default-store-selection.js";
import { loadLegacyCronRepairState } from "../cron/legacy-repair.js";
import { createDoctorModelRefResolver } from "./model-reference-resolver.js";
type DoctorModelReference = {
  path: string;
  modelRef: string;
  rawModelRef: string;
  agentId?: string;
};
export type DoctorModelReferenceInventory = {
  references: DoctorModelReference[];
  warnings: string[];
};

/** Reads selectors, not transcripts. Incomplete store scans are reported rather than treated as clean. */
export async function inspectDoctorModelReferences(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  matches: (modelRef: string) => boolean;
}): Promise<DoctorModelReferenceInventory> {
  const env = params.env ?? process.env;
  const resolve = createDoctorModelRefResolver(params.cfg);
  const refs = new Map<string, DoctorModelReference>();
  const warnings: string[] = [];
  const inspect = (value: unknown, path: string, agentId?: string) => {
    if (typeof value !== "string") {
      return;
    }
    const modelRef = resolve(value, agentId);
    if (modelRef && params.matches(modelRef)) {
      refs.set(path + ":" + modelRef, { path, modelRef, rawModelRef: value, agentId });
    }
  };
  const agentIds = listAgentIds(params.cfg);
  for (const ref of collectConfiguredModelRefs(params.cfg)) {
    const owner = agentIds.find((id) => ref.path.startsWith("agents.entries." + id + "."));
    for (const agentId of owner ? [owner] : agentIds.length ? agentIds : [undefined]) {
      inspect(ref.value, ref.path, agentId);
    }
  }
  const policies = [
    {
      path: "agents.defaults",
      policy: params.cfg.agents?.defaults?.modelPolicy,
      agentId: undefined,
    },
    ...Object.entries(params.cfg.agents?.entries ?? {}).map(([agentId, agent]) => ({
      path: "agents.entries." + agentId,
      policy: agent.modelPolicy,
      agentId,
    })),
  ];
  for (const { path, policy, agentId } of policies) {
    policy?.allow?.forEach((ref, index) =>
      inspect(ref, path + ".modelPolicy.allow." + index, agentId),
    );
  }
  try {
    const retained = createRetainedAgentDatabaseMatcher(env, () =>
      resolveConfiguredAgentDatabaseTargets(params.cfg, { env }),
    );
    for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg, { env })) {
      if (retained(target.storePath, target.agentId)) {
        continue;
      }
      scanDoctorSessionEntriesTolerant({ ...target, env }, ({ entry, sessionKey }) => {
        if (entry.modelOverride) {
          inspect(
            entry.providerOverride
              ? entry.providerOverride + "/" + entry.modelOverride
              : entry.modelOverride,
            "sessions." + target.agentId + "." + sessionKey + ".modelOverride",
            target.agentId,
          );
        }
      });
    }
  } catch {
    warnings.push(
      "Session model reference scan was incomplete; restore access to the session stores and rerun Doctor.",
    );
  }
  try {
    const selection = await readCronStoreSelectionForDoctor(params.cfg, env);
    if (selection.status !== "ready") {
      warnings.push(
        "Cron model reference scan was incomplete: select a cron partition with openclaw doctor --fix, then rerun Doctor.",
      );
    } else {
      const state = await loadLegacyCronRepairState({
        cfg: params.cfg,
        env,
        storePath: selection.storePath,
        readOnly: true,
      });
      for (const job of state?.rawJobs ?? []) {
        const owner = state?.projectedOwnersByJobId.get(String(job.id));
        const agentId =
          typeof job.agentId === "string"
            ? job.agentId
            : owner && owner.kind !== "unresolved"
              ? owner.agentId
              : undefined;
        const payload = asOptionalRecord(job.payload);
        const path = "cron." + String(job.id) + ".payload";
        visitModelSelectorRefs(payload?.model, path + ".model", (refPath, value) =>
          agentId
            ? inspect(value, refPath, agentId)
            : agentIds.forEach((id) => inspect(value, refPath, id)),
        );
        if (Array.isArray(payload?.fallbacks)) {
          payload.fallbacks.forEach((ref, index) =>
            agentId
              ? inspect(ref, path + ".fallbacks." + index, agentId)
              : agentIds.forEach((id) => inspect(ref, path + ".fallbacks." + index, id)),
          );
        }
      }
    }
  } catch {
    warnings.push(
      "Cron model reference scan was incomplete; restore access to the cron store and rerun Doctor.",
    );
  }
  return { references: [...refs.values()], warnings };
}
