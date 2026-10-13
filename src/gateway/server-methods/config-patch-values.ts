import { scanEnvTemplateTokens } from "../../config/env-substitution.js";
import type { readConfigFileSnapshotForWrite } from "../../config/io.js";
import { coerceConfig } from "../../config/io.read-helpers.js";
import { prepareConfigWriteValues } from "../../config/io.write-prepare.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import { normalizeSubmittedConfigModelRefs } from "../../config/model-input-normalization.js";
import { restoreRedactedValues } from "../../config/redact-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { visitConfigValueTree } from "../../config/value-tree.js";
import { diffConfigLeafPaths } from "./config-patch-intent.js";

type ConfigWriteSnapshot = Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>>;

/** Merge supplied values while retaining their final paths before restoring redaction. */
export function mergeGatewayConfigPatch(params: {
  snapshot: ConfigWriteSnapshot["snapshot"];
  patch: OpenClawConfig;
  replacePaths: ReadonlySet<string>;
  uiHints: Parameters<typeof restoreRedactedValues>[2];
  modelIdNormalizationPolicies: Parameters<typeof normalizeSubmittedConfigModelRefs>[1];
}) {
  // Runtime rows would persist catalog defaults from untouched ID-array siblings.
  const sourceConfig = normalizeSubmittedConfigModelRefs(
    params.snapshot.sourceConfig,
    params.modelIdNormalizationPolicies,
  );
  const referencePaths: string[][] = [];
  const merged = applyMergePatch(sourceConfig, params.patch, {
    mergeObjectArraysById: true,
    replaceArrayPaths: params.replacePaths,
    onSetValue: (value, path) => {
      visitConfigValueTree(
        value,
        (candidate, leafPath) => {
          if (typeof candidate === "string" && scanEnvTemplateTokens(candidate).length > 0) {
            referencePaths.push([...leafPath]);
          }
          return true;
        },
        path,
      );
    },
  });
  const restored = restoreRedactedValues(merged, params.snapshot.config, params.uiHints);
  if (!restored.ok) {
    return { ...restored, ok: false as const };
  }
  return { ...restored, ok: true as const, sourceConfig, referencePaths };
}

/** Prepare authored and effective values after the handler accepts the patch's array intent. */
export function prepareGatewayConfigPatchValues(
  params: ConfigWriteSnapshot & {
    patch: Extract<ReturnType<typeof mergeGatewayConfigPatch>, { ok: true }>;
  },
) {
  const { snapshot, writeOptions, patch } = params;
  // A template can equal an old escaped template's resolved text. Only paths
  // supplied by the caller may activate it, never inherited or redacted values.
  const prepared =
    patch.referencePaths.length > 0
      ? prepareConfigWriteValues({
          snapshot,
          nextConfig: coerceConfig(patch.result),
          writeOptions,
          explicitSetPaths: patch.referencePaths,
          env: writeOptions.envSnapshotForRestore ?? process.env,
        })
      : undefined;
  return {
    changedPaths: [
      ...new Set([
        ...diffConfigLeafPaths(patch.sourceConfig, patch.result),
        ...(prepared
          ? diffConfigLeafPaths(prepared.authoredSourceConfig, prepared.authoredConfig)
          : []),
      ]),
    ],
    validationCandidate: prepared?.resolvedConfig ?? patch.result,
    authoredConfig: prepared?.authoredConfig,
    writeOptions: prepared
      ? { ...writeOptions, explicitSetPaths: patch.referencePaths }
      : writeOptions,
  };
}
