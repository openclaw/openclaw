import { restoreDoctorConfigEnvRefs } from "../commands/doctor/shared/config-flow-steps.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
import { createMergePatch } from "../config/merge-patch.js";
import { resolveIsConfigReadOnly } from "../config/paths.js";
import { redactConfigObject } from "../config/redact-snapshot.js";
import { buildRuntimeConfigSchemaFromRegistry } from "../config/runtime-schema.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

/** Report the candidate without granting the authority of a committed config write. */
export async function reportDoctorExternalConfigRepairs(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  const snapshot = await readConfigFileSnapshot({ observe: false });
  const candidate = restoreDoctorConfigEnvRefs(
    ctx.cfg,
    ctx.configResult.referenceSource,
    ctx.configResult.explicitSetPaths,
  );
  const before = ctx.externalConfigRepairsPending
    ? restoreDoctorConfigEnvRefs(ctx.cfgForPersistence, ctx.configResult.referenceSource)
    : (ctx.configResult.referenceSource?.authored ??
      snapshot.sourceConfigBeforeMigrations ??
      snapshot.sourceConfig);
  const patch = createMergePatch(before, candidate);
  const registry = resolveConfigWidePluginManifestRegistry({
    config: ctx.cfg,
    env: ctx.env ?? process.env,
  });
  const { uiHints } = buildRuntimeConfigSchemaFromRegistry(registry, ctx.cfg);
  ctx.runtime.log(
    [
      `Config repairs pending in externally managed ${snapshot.path}; no config files were changed.`,
      "Apply this merge patch in the external deployment source (null removes a key; arrays replace the whole array). For $include-owned keys, edit the included source. Redacted values must be supplied externally, not copied from this report.",
      JSON.stringify(redactConfigObject(patch, uiHints), null, 2),
    ].join("\n"),
  );
  ctx.externalConfigRepairsPending = true;
  ctx.configResult.shouldWriteConfig = false;
  delete ctx.configResult.pendingChangePanels;
  delete ctx.configResult.retiredModelRefConfig;
  // Subsequent state repairs and readiness checks must consume the persisted config.
  ctx.cfg = snapshot.config;
  ctx.cfgForPersistence = structuredClone(snapshot.config);
}

export async function validateDoctorExternalConfigForStartup(
  runtime: RuntimeEnv,
): Promise<boolean> {
  if (!resolveIsConfigReadOnly()) {
    return true;
  }
  const persisted = await readConfigFileSnapshot({ observe: false });
  if (persisted.valid && persisted.legacyIssues.length === 0) {
    return true;
  }
  for (const issue of [...persisted.issues, ...persisted.legacyIssues]) {
    runtime.error(`- ${issue.path || "<root>"}: ${issue.message}`);
  }
  runtime.error(
    `Gateway startup requires the pending config repairs. Apply the reported edits in the external source for ${persisted.path}, then redeploy. No config files were changed.`,
  );
  return false;
}
