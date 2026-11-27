import {
  buildQualifiedChatModelValue,
  resolvePreferredServerChatModelValue,
} from "../chat/model-ref.ts";
import { normalizeThinkingOptionValue } from "../chat/thinking.ts";
import type { ModelCatalogPresentation } from "../model-catalog-store.ts";
import type { CronFieldErrors, CronFormState } from "./types.ts";

type CatalogSnapshot = Pick<ModelCatalogPresentation, "hasSnapshot" | "retired" | "models">;

type PersistedThinkingSelection = {
  model?: string;
  thinking?: string;
};

/**
 * Reject a new explicit level only when the current catalog can authoritatively
 * prove the selected model does not offer it. Existing unknown or stale jobs
 * stay editable so operators can repair unrelated settings or pause them.
 */
export function getCronModelThinkingIncompatibility(
  form: Pick<CronFormState, "payloadKind" | "payloadModel" | "payloadThinking">,
  catalog: CatalogSnapshot | undefined,
  persisted?: PersistedThinkingSelection,
): { unchangedPersistedSelection: boolean; supportedLevels: string[] } | undefined {
  const model = form.payloadModel.trim();
  const requestedThinking = normalizeThinkingOptionValue(form.payloadThinking);
  if (
    form.payloadKind !== "agentTurn" ||
    !model ||
    !requestedThinking ||
    !catalog?.hasSnapshot ||
    catalog.retired
  ) {
    return undefined;
  }

  const value = resolvePreferredServerChatModelValue(model, undefined, catalog.models);
  const knownModel = value
    ? catalog.models.find(
        (entry) =>
          buildQualifiedChatModelValue(entry.id, entry.provider).toLowerCase() ===
          value.toLowerCase(),
      )
    : undefined;
  // An omitted levels list means this catalog entry cannot make a compatibility claim.
  if (!knownModel?.thinkingLevels) {
    return undefined;
  }

  const supported = knownModel.thinkingLevels.some(
    (level) => normalizeThinkingOptionValue(level.id) === requestedThinking,
  );
  // An explicit empty profile hides all picker choices, but preserves a legacy Off override.
  if (supported || (knownModel.thinkingLevels.length === 0 && requestedThinking === "off")) {
    return undefined;
  }

  return {
    unchangedPersistedSelection:
      persisted?.model?.trim() === model &&
      normalizeThinkingOptionValue(persisted.thinking ?? "") === requestedThinking,
    supportedLevels: knownModel.thinkingLevels.map((level) => level.label),
  };
}

export function validateCronModelThinkingSelection(
  form: Pick<CronFormState, "payloadKind" | "payloadModel" | "payloadThinking">,
  catalog: CatalogSnapshot | undefined,
  persisted?: PersistedThinkingSelection,
): CronFieldErrors {
  const incompatibility = getCronModelThinkingIncompatibility(form, catalog, persisted);
  return !incompatibility || incompatibility.unchangedPersistedSelection
    ? {}
    : { payloadThinking: "cron.errors.payloadThinkingUnsupported" };
}
