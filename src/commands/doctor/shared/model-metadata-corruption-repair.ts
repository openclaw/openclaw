import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ConfigAuditRecord } from "../../../config/io.audit.js";
import { getRecord } from "../../../config/legacy.shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  providerModelEntries,
  resolveConfiguredModelCatalogOwnership,
} from "./legacy-config-migrations.runtime.models.catalog.js";

const GENERATED_MODEL_FALLBACK = {
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  input: ["text"],
  maxTokens: 8192,
  reasoning: false,
} as const;
// The old writer persisted this complete generic-default tuple into untouched rows.
// Requiring every field avoids reclassifying ordinary explicit capability overrides.
const GENERATED_MODEL_FIELDS = ["cost", "input", "maxTokens", "reasoning"] as const;

type ConfigWriteRecord = Extract<ConfigAuditRecord, { event: "config.write" }>;

function hasGeneratedFallbackFingerprint(model: Record<string, unknown>): boolean {
  return GENERATED_MODEL_FIELDS.every(
    (field) =>
      Object.hasOwn(model, field) &&
      isDeepStrictEqual(model[field], GENERATED_MODEL_FALLBACK[field]),
  );
}

function isHistoricalMaterializingWriter(record: ConfigWriteRecord): boolean {
  const updateFinalize = record.argv.some(
    (arg, index) => arg === "update" && record.argv[index + 1] === "finalize",
  );
  const repairDoctor =
    record.origin === "doctor" &&
    record.argv.includes("doctor") &&
    (record.argv.includes("--fix") || record.argv.includes("--yes"));
  return updateFinalize || repairDoctor;
}

function hasAuditProvenance(params: {
  auditRecords: readonly ConfigAuditRecord[];
  configPath: string;
  currentHash: string;
  modelPath: string;
}): boolean {
  const configPath = path.resolve(params.configPath);
  return params.auditRecords.some(
    (record) =>
      record.event === "config.write" &&
      (record.result === "rename" || record.result === "copy-fallback") &&
      path.resolve(record.configPath) === configPath &&
      record.nextHash === params.currentHash &&
      isHistoricalMaterializingWriter(record) &&
      GENERATED_MODEL_FIELDS.every((field) =>
        record.changedPaths?.some(
          (changedPath) =>
            changedPath === `${params.modelPath}.${field}` ||
            changedPath.startsWith(`${params.modelPath}.${field}.`),
        ),
      ),
  );
}

/** Repairs audit-proven model metadata written by the historical runtime-materialization bug. */
export function repairGeneratedModelMetadataCorruption(params: {
  config: OpenClawConfig;
  authoredRoot: unknown;
  configPath: string;
  currentHash: string | null;
  loadAuditRecords: () => readonly ConfigAuditRecord[];
}): { config: OpenClawConfig; changes: string[]; warnings: string[] } {
  let next: OpenClawConfig | undefined;
  let auditRecords: readonly ConfigAuditRecord[] | undefined;
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const { providerId, provider, modelIndex, model } of providerModelEntries(
    params.config.models?.providers,
  )) {
    const modelId = typeof model.id === "string" ? model.id : "";
    if (!modelId || !hasGeneratedFallbackFingerprint(model)) {
      continue;
    }
    const authoredProvider = getRecord(
      getRecord(getRecord(params.authoredRoot)?.models)?.providers,
    )?.[providerId];
    const authoredModels = getRecord(authoredProvider)?.models;
    const authoredCandidate = Array.isArray(authoredModels)
      ? getRecord(authoredModels[modelIndex])
      : undefined;
    const authoredModel = authoredCandidate?.id === modelId ? authoredCandidate : undefined;
    const catalog = resolveConfiguredModelCatalogOwnership({ providerId, provider, model });
    if (
      !catalog ||
      GENERATED_MODEL_FIELDS.every((field) =>
        isDeepStrictEqual(catalog.catalogRow[field], GENERATED_MODEL_FALLBACK[field]),
      )
    ) {
      continue;
    }
    const modelPath = `models.providers.${providerId}.models[${modelIndex}]`;
    if (!catalog.ownsRoute) {
      warnings.push(
        `${modelPath} matches the historical generated model-metadata fingerprint, but its configured API route is not owned by the shipped provider catalog. It was left unchanged.`,
      );
      continue;
    }
    const auditProven =
      authoredModel &&
      hasGeneratedFallbackFingerprint(authoredModel) &&
      params.currentHash &&
      hasAuditProvenance({
        auditRecords: (auditRecords ??= params.loadAuditRecords()),
        configPath: params.configPath,
        currentHash: params.currentHash,
        modelPath,
      });
    if (!auditProven) {
      warnings.push(
        `${modelPath} matches the historical generated model-metadata fingerprint, but Doctor could not prove the responsible config write. It was left unchanged. If the provider catalog should own these capabilities, remove cost, input, maxTokens, and reasoning from this model entry.`,
      );
      continue;
    }
    const repairedModel = (next ??= structuredClone(params.config)).models!.providers![providerId]!
      .models[modelIndex]!;
    for (const field of GENERATED_MODEL_FIELDS) {
      Reflect.deleteProperty(repairedModel, field);
    }
    changes.push(
      `Removed audit-proven generated model metadata from ${modelPath}: cost, input, maxTokens, reasoning.`,
    );
  }
  return { config: next ?? params.config, changes, warnings };
}
