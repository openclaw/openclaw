import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { canonicalizeCronModelReplacementAliases } from "../cron/legacy-repair.js";
import { maybeRepairCodexSessionRoutes } from "./codex-route-session-repair.js";
import { createModelAliasCanonicalizer } from "./model-alias-canonicalization.js";
import { inspectDoctorModelReferences } from "./model-reference-inventory.js";
import { prepareModelReplacementConfig } from "./model-replacement-config.js";
import type { DoctorModelReplacement } from "./model-replacement.js";

/** Preserve source identities durably before moving aliases, so interrupted runs remain repairable. */
export async function prepareExplicitModelReplacement(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  choices: readonly DoctorModelReplacement[];
}): Promise<{ changes: string[]; warnings: string[] }> {
  const env = params.env;
  const changes: string[] = [];
  const warnings: string[] = [];
  const append = (result: { changes: string[]; warnings: string[] }) => {
    changes.push(...result.changes);
    warnings.push(...result.warnings);
  };
  // Never erase the only durable source identity while a skipped selector still uses it.
  prepareModelReplacementConfig(params.cfg, params.choices);
  append(
    await maybeRepairCodexSessionRoutes({
      cfg: params.cfg,
      env,
      shouldRepair: true,
      modelReplacements: params.choices,
      canonicalizeModelAliasesOnly: true,
    }),
  );
  const cronAliases = await canonicalizeCronModelReplacementAliases({
    cfg: params.cfg,
    env,
    modelReplacements: params.choices,
  });
  append(cronAliases);
  const canonicalize = createModelAliasCanonicalizer(params.cfg, params.choices);
  const sources = new Set(params.choices.map((choice) => choice.from));
  const remaining = await inspectDoctorModelReferences({
    cfg: params.cfg,
    env,
    matches: (ref) => sources.has(ref),
  });
  if (
    cronAliases.warnings.length ||
    remaining.warnings.length ||
    remaining.references.some(
      (ref) =>
        (ref.path.startsWith("sessions.") || ref.path.startsWith("cron.")) &&
        (!ref.agentId || canonicalize(ref.rawModelRef, ref.agentId)),
    )
  ) {
    throw new Error(
      "Model replacement deferred: some saved aliases could not be prepared safely. Unlock affected model selections or restore access to the reported stores, then rerun the same Doctor command. Config aliases were not retargeted.",
    );
  }
  return { changes, warnings };
}
