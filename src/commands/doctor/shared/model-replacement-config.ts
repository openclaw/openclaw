import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAgentDir } from "../../../agents/agent-scope.js";
import { loadAuthProfileStoreForSecretsRuntime } from "../../../agents/auth-profiles/store-runtime.js";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { DoctorModelReplacement } from "./model-replacement.js";
import type { ModelRefRepair } from "./retired-model-ref-repair.types.js";
import { resolveSuccessorModelRepair } from "./retired-model-successor-guard.js";

function withAccessProgram(settings: unknown, cyber: DoctorModelReplacement["accessProgram"]) {
  const row = asOptionalRecord(settings) ?? {};
  const params = asOptionalRecord(row.params);
  return {
    ...row,
    params: { ...params, accessPrograms: { ...asOptionalRecord(params?.accessPrograms), cyber } },
  };
}

/** Persist explicit target settings before migrating durable selectors. Never replace existing access choices. */
export function prepareModelReplacementConfig(
  cfg: OpenClawConfig,
  choices: readonly DoctorModelReplacement[],
) {
  const changes: string[] = [];
  if (choices.length === 0) {
    return { config: cfg, changes };
  }
  const config = structuredClone(cfg);
  for (const choice of choices) {
    const settings = [
      config.agents?.defaults?.models?.[choice.to],
      ...Object.values(config.agents?.entries ?? {}).map((agent) => agent.models?.[choice.to]),
    ];
    if (
      settings.some((entry) => {
        const program = asOptionalRecord(entry?.params?.accessPrograms)?.cyber;
        return program !== undefined && program !== choice.accessProgram;
      })
    ) {
      throw new Error(
        "Cannot replace " +
          choice.from +
          ": " +
          choice.to +
          " already selects a different Access program. Choose a different target or reconcile its settings first.",
      );
    }
    config.agents ??= {};
    config.agents.defaults ??= {};
    const models = (config.agents.defaults.models ??= {});
    const existing = models[choice.to];
    const updated = withAccessProgram(existing, choice.accessProgram);
    if (JSON.stringify(existing) !== JSON.stringify(updated)) {
      models[choice.to] = updated;
      changes.push(
        "Set " +
          choice.to +
          " Access to " +
          choice.accessProgram +
          " for the explicit model replacement.",
      );
    }
  }
  return { config: changes.length ? config : cfg, changes };
}

/** Apply explicit choices through the same account/policy guard as declared retirements. */
export function resolveExplicitModelReplacement(params: {
  choice: DoctorModelReplacement;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  guard: Omit<Parameters<typeof resolveSuccessorModelRepair>[0], "retirement" | "retirementScope">;
}) {
  const { choice, cfg, guard } = params;
  const pinned =
    (guard.authProfileSource === "user" || guard.authProfileSource === "user-link"
      ? guard.authProfileId
      : undefined) ?? splitTrailingAuthProfile(guard.modelRefInput).profile;
  if (
    pinned &&
    !loadAuthProfileStoreForSecretsRuntime(resolveAgentDir(cfg, guard.agentId, params.env), {
      config: cfg,
      profileId: pinned,
    }).profiles[pinned]
  ) {
    guard.warn(
      "Retained " +
        guard.canonical +
        ": its pinned account is unavailable. Restore that account or select another account explicitly.",
    );
    return guard.preserved;
  }
  const targets = [
    cfg.agents?.defaults?.models?.[choice.to],
    ...Object.values(cfg.agents?.entries ?? {}).map((agent) => agent.models?.[choice.to]),
  ];
  if (
    targets.some((settings) => {
      const program = asOptionalRecord(settings?.params?.accessPrograms)?.cyber;
      return program !== undefined && program !== choice.accessProgram;
    })
  ) {
    guard.warn(
      "Retained " +
        guard.canonical +
        ": the chosen Access program conflicts with existing settings for " +
        choice.to +
        ".",
    );
    return guard.preserved;
  }
  const result = resolveSuccessorModelRepair({
    ...guard,
    retirement: { replacedBy: choice.to.slice(guard.provider.length + 1) },
    retirementScope: "provider",
  });
  return result.kind === "replace" && result.reason === "retirement"
    ? { ...result, cyberAccessProgram: choice.accessProgram }
    : result;
}

/** The explicit choice wins over copied source settings in both inherited and local moves. */
export function withReplacementAccessProgram(settings: unknown, decision: ModelRefRepair) {
  return decision.kind === "replace" &&
    decision.reason === "retirement" &&
    decision.cyberAccessProgram
    ? withAccessProgram(settings, decision.cyberAccessProgram)
    : settings;
}
