import type { ModelCatalogEntry } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { buildQualifiedChatModelValue } from "../../lib/chat/model-ref.ts";
import { resolveModelRuntimeEntry } from "../../lib/model-runtime-choice.ts";
import type { DraftCloudProfile } from "./discovery.ts";
import type { NewSessionModelSelection } from "./model-selection.ts";
import {
  resolveDraftModelTarget,
  resolveDraftDevicePlacementUnsupportedReason,
  resolveDraftCloudRuntimeUnsupportedReason,
} from "./model-target.ts";

registerNewSessionSetupEnglish();

/** Presentation only: readiness, auth, and manual policy are projected by models.list. */
export function resolveHostedEnvironments(
  catalog: ModelCatalogEntry[],
  currentModel: string,
  ready: boolean,
) {
  const choices = new Map<
    string,
    { id: string; label: string; model?: string; disabledReason?: string }
  >();
  for (const model of catalog) {
    const value = buildQualifiedChatModelValue(model.id, model.provider);
    for (const runtime of [
      model.agentRuntime,
      ...(model.runtimeChoices ?? []).map((choice) => choice.agentRuntime),
    ]) {
      if (runtime?.workspaceEnvironment?.kind !== "provider-hosted") {
        continue;
      }
      const entry = resolveModelRuntimeEntry(model, runtime.id);
      const selectable =
        ready && entry?.available === true && entry.manualSelectionAllowed !== false;
      const previous = choices.get(runtime.id);
      if (previous?.model && (!selectable || value !== currentModel)) {
        continue;
      }
      choices.set(runtime.id, {
        id: runtime.id,
        label: runtime.workspaceEnvironment.label,
        ...(selectable ? { model: value } : { disabledReason: t("newSession.hostedUnavailable") }),
      });
    }
  }
  return [...choices.values()];
}

export function resolveHostEnvironmentChoice(
  catalog: ModelCatalogEntry[],
  selectedModel: string | undefined,
) {
  const target = resolveDraftModelTarget(selectedModel, undefined, catalog);
  const model =
    target &&
    catalog.find((entry) => entry.id === target.model && entry.provider === target.provider);
  if (!model) {
    return undefined;
  }
  const choice = [model, ...(model.runtimeChoices ?? [])].find(
    (entry) =>
      entry.agentRuntime &&
      !entry.agentRuntime.workspaceEnvironment &&
      entry.available === true &&
      entry.manualSelectionAllowed !== false,
  );
  return choice?.agentRuntime
    ? {
        model: buildQualifiedChatModelValue(model.id, model.provider),
        runtime: choice.agentRuntime,
      }
    : undefined;
}

export function environmentPlacementRuntime(control: NewSessionModelSelection) {
  return control.hostEnvironmentRuntime()?.runtime ?? control.resolveAgentRuntime();
}
export function environmentDeviceDisabledReason(control: NewSessionModelSelection) {
  return (
    control.hostEnvironmentDisabledReason() ??
    resolveDraftDevicePlacementUnsupportedReason(environmentPlacementRuntime(control))
  );
}
export function environmentCloudDisabledReason(
  control: NewSessionModelSelection,
  profile?: DraftCloudProfile,
) {
  return (
    control.hostEnvironmentDisabledReason() ??
    resolveDraftCloudRuntimeUnsupportedReason(environmentPlacementRuntime(control), profile)
  );
}
