import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { collectConfigSecretProviderErrors } from "../cli/config-cli-validation.js";
import { planLegacyConfigForUpdateChannel } from "../commands/doctor/legacy-config-repair.js";
import {
  prepareDoctorConfigReferenceSource,
  restoreDoctorConfigEnvRefs,
} from "../commands/doctor/shared/config-flow-steps.js";
import { containsAuthoredInclude } from "../commands/doctor/shared/include-migration-ownership.js";
import { collectConfigWriteChangedPaths } from "../config/config-change-paths.js";
import { createConfigIO } from "../config/io.factory.js";
import { validateConfigObjectRawWithPlugins } from "../config/validation.js";
import { preparePluginDoctorContractModules } from "../plugins/doctor-contract-preparation.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";

/** The deployment controller owns backup, journaling and publication after its managed stop. */
export async function projectUpdateConfig() {
  return await withArtifactPreservingStateReads(async () => {
    const snapshot = await createConfigIO({
      observe: false,
      pluginValidation: "core-only",
      shellEnvFallback: "defer",
      suppressFutureVersionWarning: true,
    }).readConfigFileSnapshot();
    if (
      !snapshot.exists ||
      snapshot.readError ||
      snapshot.issues.some(
        (issue) =>
          issue.errorCode === "CONFIG_SOURCE_INVALID" || issue.errorCode === "CONFIG_READ_FAILED",
      ) ||
      snapshot.raw === null ||
      !isRecord(snapshot.parsed)
    ) {
      throw new Error(
        "Cannot read deployment config; repair the authored config before deploying.",
      );
    }
    const sourceValidation = validateConfigObjectRawWithPlugins(snapshot.sourceConfig, {
      semanticValidation: "strict",
    });
    let plan: ReturnType<typeof planLegacyConfigForUpdateChannel>;
    if (!sourceValidation.ok) {
      await preparePluginDoctorContractModules({
        config: snapshot.sourceConfig,
        surfaces: ["configRepair"],
        artifactPreservingReadOnly: true,
      });
      plan = planLegacyConfigForUpdateChannel(snapshot, {}, "strict");
    }
    const validation = plan ? { ok: true as const, config: plan.config } : sourceValidation;
    const issues = validation.ok
      ? await collectConfigSecretProviderErrors({ config: validation.config })
      : validation.issues;
    if (issues.length) {
      throw new Error(
        `Deployment config remains invalid at: ${issues.map((issue) => issue.path || "<root>").join(", ")}. Run openclaw doctor --fix and correct remaining errors.`,
      );
    }
    if (plan?.changes.length && containsAuthoredInclude(snapshot.parsed)) {
      throw new Error(
        "Deployment config projection does not write $include files; run Doctor first.",
      );
    }
    const config = plan?.changes.length
      ? restoreDoctorConfigEnvRefs(plan.nextConfig, prepareDoctorConfigReferenceSource(snapshot))
      : snapshot.parsed;
    return {
      configPath: snapshot.path,
      originalSha256: createHash("sha256").update(snapshot.raw).digest("hex"),
      config,
      changedPaths: [...collectConfigWriteChangedPaths(snapshot.parsed, config, [])].toSorted(),
      changes: plan?.changes ?? [],
    };
  });
}
