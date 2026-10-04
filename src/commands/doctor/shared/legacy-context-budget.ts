import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConfigValidationIssue } from "../../../config/types.openclaw.js";

type JsonRecord = Record<string, unknown>;

const MODEL_CONTEXT_TOKENS_REPLACEMENT = "models.providers.<provider>.models[].contextTokens";

type ContextBudgetConfigMigration = {
  config: JsonRecord;
  changed: boolean;
  changes: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
};

export function hasLegacyContextBudgetConfig(root: unknown): boolean {
  if (!isRecord(root)) {
    return false;
  }
  const providers = isRecord(root.models) ? root.models.providers : undefined;
  if (
    isRecord(providers) &&
    Object.values(providers).some(
      (provider) =>
        isRecord(provider) &&
        (Object.hasOwn(provider, "contextTokens") || Object.hasOwn(provider, "contextWindow")),
    )
  ) {
    return true;
  }
  return !legacyAgentContextBudgets(root).next().done;
}

function* legacyAgentContextBudgets(root: JsonRecord) {
  const agents = root.agents;
  if (!isRecord(agents)) {
    return;
  }
  const scopes: Array<[unknown, string]> = [[agents.defaults, "agents.defaults.contextTokens"]];
  if (isRecord(agents.entries)) {
    scopes.push(
      ...Object.entries(agents.entries).map(([id, entry]): [unknown, string] => [
        entry,
        `agents.entries.${id}.contextTokens`,
      ]),
    );
  }
  if (Array.isArray(agents.list)) {
    for (const [index, entry] of agents.list.entries()) {
      scopes.push([entry, `agents.list[${index}].contextTokens`]);
    }
  }
  for (const [record, path] of scopes) {
    if (isRecord(record) && Object.hasOwn(record, "contextTokens")) {
      yield { record, path };
    }
  }
}

function migrateProviderContextBudgets(
  root: JsonRecord,
  changes: ConfigValidationIssue[],
  warnings: ConfigValidationIssue[],
): void {
  const providers = isRecord(root.models) ? root.models.providers : undefined;
  if (!isRecord(providers)) {
    return;
  }
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) {
      continue;
    }
    for (const key of ["contextTokens", "contextWindow"] as const) {
      if (!Object.hasOwn(provider, key)) {
        continue;
      }
      const sourcePath = `models.providers.${providerId}.${key}`;
      if (Array.isArray(provider.models) && provider.models.length > 0) {
        for (const [index, model] of provider.models.entries()) {
          if (!isRecord(model) || model[key] !== undefined) {
            continue;
          }
          model[key] = provider[key];
          changes.push({
            path: sourcePath,
            message: `${sourcePath} → models.providers.${providerId}.models[${index}].${key}.`,
          });
        }
        delete provider[key];
        changes.push({
          path: sourcePath,
          message: `Removed ${sourcePath} after baking it into explicit model entries.`,
        });
        continue;
      }
      delete provider[key];
      changes.push({ path: sourcePath, message: `Removed ${sourcePath}.` });
      warnings.push({
        path: sourcePath,
        message: `${sourcePath} had no explicit model entries to receive its value; use ${MODEL_CONTEXT_TOKENS_REPLACEMENT} instead.`,
      });
    }
  }
}

/** Doctor preserves provider budgets and reports unrepresentable agent caps before validation. */
export function migrateLegacyContextBudgetConfig(raw: JsonRecord): ContextBudgetConfigMigration {
  if (!hasLegacyContextBudgetConfig(raw)) {
    return { config: raw, changed: false, changes: [], warnings: [] };
  }
  const next = structuredClone(raw);
  const changes: ConfigValidationIssue[] = [];
  const warnings: ConfigValidationIssue[] = [];
  migrateProviderContextBudgets(next, changes, warnings);
  for (const { record, path } of legacyAgentContextBudgets(next)) {
    delete record.contextTokens;
    changes.push({ path, message: `Removed ${path}.` });
    warnings.push({
      path,
      message: `${path} cannot be represented per model; use ${MODEL_CONTEXT_TOKENS_REPLACEMENT} instead.`,
    });
  }
  return changes.length > 0
    ? { config: next, changed: true, changes, warnings }
    : { config: raw, changed: false, changes, warnings };
}
