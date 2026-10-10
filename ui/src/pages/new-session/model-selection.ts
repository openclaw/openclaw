import type { FastMode, GatewayAgentRow } from "../../api/types.ts";
import type { DurableDraftModelSelection } from "../../lib/chat/composer-draft-store.runtime.ts";
import { normalizeThinkingOptionValue } from "../../lib/chat/thinking.ts";
import type { ModelRuntimeEntry } from "../../lib/model-runtime-choice.ts";
import type { DraftCloudProfile } from "./discovery.ts";
import {
  reconcileDraftModelSelection,
  resolveDraftModelTarget,
  resolveDraftDefaultModelTarget,
  resolveDraftDevicePlacementUnsupportedReason,
  resolveDraftCloudRuntimeUnsupportedReason,
} from "./model-target.ts";
import type { NewSessionPreference } from "./preferences.ts";

export type NewSessionModelLoadOptions = {
  agent?: GatewayAgentRow;
  preference?: NewSessionPreference | null;
  initialModel?: string;
  configuredDefaults?: boolean;
};

export type ModelSelectionChange = (
  selection: Pick<NewSessionPreference, "model" | "agentRuntime" | "thinkingLevel" | "fastMode">,
) => void;

/** Mutable intent belongs to this draft, separate from remembered defaults and catalog metadata. */
export abstract class NewSessionModelSelection {
  abstract resolveAgentRuntime(): ModelRuntimeEntry["agentRuntime"];
  abstract hostedEnvironments(): Array<{ id: string; model?: string }>;
  abstract hostEnvironmentRuntime():
    | { model: string; runtime: NonNullable<ModelRuntimeEntry["agentRuntime"]> }
    | undefined;
  abstract selectModel(model: string, agentRuntime?: string): void;
  abstract hostEnvironmentDisabledReason(): string | undefined;

  selectHostedEnvironment(id: string): boolean {
    const choice = this.hostedEnvironments().find((entry) => entry.id === id);
    if (!choice?.model) {
      return false;
    }
    this.selectModel(choice.model, id);
    return true;
  }

  selectHostEnvironment(): boolean {
    if (!this.resolveAgentRuntime()?.workspaceEnvironment) {
      return true;
    }
    const choice = this.hostEnvironmentRuntime();
    if (!choice) {
      return false;
    }
    this.selectModel(choice.model, choice.runtime.id);
    return true;
  }

  devicePlacementUnsupportedReason(): string | undefined {
    return resolveDraftDevicePlacementUnsupportedReason(this.resolveAgentRuntime());
  }

  // Worker-turn runtimes rank automatic placement by free worker slots;
  // remote-exec runtimes select by eligible device order and must not be
  // described as least-busy. Unresolved (auto/default) runtimes fall back to
  // the worker-turn description, matching the server's default policy.
  autoPlacementSelectionMode(
    runtime = this.resolveAgentRuntime(),
  ): "least-busy" | "eligible-order" {
    return runtime?.cloudPlacementExecutionMode === "remote-exec" ? "eligible-order" : "least-busy";
  }

  cloudRuntimeUnsupportedReason(profile?: DraftCloudProfile): string | undefined {
    return resolveDraftCloudRuntimeUnsupportedReason(this.resolveAgentRuntime(), profile);
  }

  private selectionOrigin: "none" | "restored" | "explicit" = "none";
  protected fastModeSelected = false;
  protected pendingDraftSelection: DurableDraftModelSelection | undefined;
  onDraftSelectionChange: (() => void) | undefined;
  selected = "";
  agentRuntime: string | undefined;
  contextWindow = "";
  thinkingLevel = "";
  fastMode: FastMode | undefined;

  constructor(private readonly onSelectionChange: ModelSelectionChange) {}

  protected resetSelection(model = "") {
    this.selected = model;
    this.agentRuntime = undefined;
    this.contextWindow = "";
    this.thinkingLevel = "";
    this.fastMode = undefined;
    this.selectionOrigin = "none";
    this.fastModeSelected = false;
  }

  protected applyModelSelection(selection: ReturnType<typeof reconcileDraftModelSelection>) {
    this.selected = selection.model;
    this.agentRuntime = selection.agentRuntime;
    this.thinkingLevel = selection.thinkingLevel;
    this.fastMode = selection.fastMode;
  }

  draftSelection(agentId: string): DurableDraftModelSelection | undefined {
    return this.selectionOrigin !== "none"
      ? {
          agentId,
          model: this.selected,
          agentRuntime: this.agentRuntime,
          thinkingLevel: this.thinkingLevel,
        }
      : undefined;
  }

  protected preferenceForDraft(
    preference: NewSessionPreference | null | undefined,
    options: {
      policy: "configured" | "last-used" | null | undefined;
      initialModel: string | undefined;
      initialModelPending: boolean;
    },
  ): NewSessionPreference | null | undefined {
    const fastMode =
      this.fastModeSelected || preference === undefined ? this.fastMode : preference?.fastMode;
    // Saved defaults seed a draft; only explicit intent is authoritative after that.
    if (this.selectionOrigin !== "none") {
      return {
        model: this.selected,
        agentRuntime: this.agentRuntime,
        thinkingLevel: this.thinkingLevel,
        fastMode,
      };
    }
    if (options.initialModel) {
      return options.initialModelPending ? { model: options.initialModel } : undefined;
    }
    return options.policy === "configured" || options.policy === null
      ? { fastMode }
      : this.fastModeSelected
        ? { ...preference, fastMode }
        : preference;
  }

  protected takeDraftSelection(agentId: string, configured: boolean, fastMode?: FastMode) {
    const selection = this.pendingDraftSelection;
    if (!configured || !selection || selection.agentId !== agentId) {
      return undefined;
    }
    this.pendingDraftSelection = undefined;
    if (this.selectionOrigin === "explicit") {
      return undefined;
    }
    this.selectionOrigin = "restored";
    this.selected = selection.model;
    this.agentRuntime = selection.agentRuntime;
    this.thinkingLevel = selection.thinkingLevel;
    if (!this.fastModeSelected) {
      this.fastMode = fastMode ?? this.fastMode;
    }
    return { ...selection, fastMode: this.fastMode };
  }

  protected markExplicitSelection() {
    this.selectionOrigin = "explicit";
  }

  protected retireModelSelection(restoredOnly: boolean): boolean {
    if (restoredOnly && this.selectionOrigin !== "restored") {
      return false;
    }
    this.selectionOrigin = "none";
    if (!restoredOnly) {
      this.fastModeSelected = false;
    }
    this.pendingDraftSelection = undefined;
    this.selected = "";
    this.agentRuntime = undefined;
    this.thinkingLevel = "";
    this.contextWindow = "";
    return true;
  }

  protected restoreModelPreference(
    preference: NewSessionPreference | null | undefined,
    options: Omit<
      Parameters<typeof reconcileDraftModelSelection>[0],
      "model" | "agentRuntime" | "thinkingLevel" | "fastMode"
    >,
    persistRepair: boolean,
  ) {
    if (!preference) {
      return;
    }
    const selection = reconcileDraftModelSelection({
      model: preference.model ?? "",
      agentRuntime: preference.agentRuntime,
      thinkingLevel: preference.thinkingLevel ?? "",
      fastMode: preference.fastMode,
      ...options,
    });
    this.applyModelSelection(selection);
    if (selection.repaired && persistRepair) {
      this.persistSelection(preference.agentRuntime ? (this.agentRuntime ?? "") : undefined);
    }
  }

  protected selectModelIntent(
    model: string,
    agentRuntime: string | undefined,
    options: Omit<
      Parameters<typeof reconcileDraftModelSelection>[0],
      "model" | "agentRuntime" | "thinkingLevel" | "fastMode"
    >,
    effectiveModel: string,
  ) {
    const selection = reconcileDraftModelSelection({
      model,
      agentRuntime,
      thinkingLevel: this.thinkingLevel,
      fastMode: this.fastMode,
      ...options,
    });
    if (
      selection.model === effectiveModel &&
      selection.agentRuntime === this.agentRuntime &&
      selection.fastMode === this.fastMode &&
      normalizeThinkingOptionValue(selection.thinkingLevel) ===
        normalizeThinkingOptionValue(this.thinkingLevel)
    ) {
      return false;
    }
    const runtimeChanged = this.agentRuntime !== selection.agentRuntime;
    this.applyModelSelection(selection);
    this.markExplicitSelection();
    const target =
      resolveDraftModelTarget(selection.model, undefined, options.catalog, this.agentRuntime) ??
      resolveDraftDefaultModelTarget(options);
    this.contextWindow = "";
    return { target, runtimeChanged };
  }

  protected persistSelection(agentRuntime = this.agentRuntime) {
    this.onSelectionChange({
      model: this.selected,
      ...(agentRuntime !== undefined ? { agentRuntime } : {}),
      thinkingLevel: this.thinkingLevel,
      fastMode: this.fastMode,
    });
  }
}
