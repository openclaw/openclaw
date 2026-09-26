import type { FastMode, GatewayAgentRow } from "../../api/types.ts";
import type { DurableDraftModelSelection } from "../../lib/chat/composer-draft-store.runtime.ts";
import { reconcileDraftModelSelection } from "./model-target.ts";
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
export class NewSessionModelSelection {
  protected explicitSelection = false;
  private restoredSelection = false;
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
    this.explicitSelection = false;
    this.restoredSelection = false;
    this.fastModeSelected = false;
  }

  protected applyModelSelection(selection: ReturnType<typeof reconcileDraftModelSelection>) {
    this.selected = selection.model;
    this.agentRuntime = selection.agentRuntime;
    this.thinkingLevel = selection.thinkingLevel;
    this.fastMode = selection.fastMode;
  }

  draftSelection(agentId: string): DurableDraftModelSelection | undefined {
    return this.explicitSelection
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
    if (this.explicitSelection) {
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
    if (this.explicitSelection && !this.restoredSelection) {
      return undefined;
    }
    this.explicitSelection = true;
    this.restoredSelection = true;
    this.selected = selection.model;
    this.agentRuntime = selection.agentRuntime;
    this.thinkingLevel = selection.thinkingLevel;
    if (!this.fastModeSelected) {
      this.fastMode = fastMode ?? this.fastMode;
    }
    return { ...selection, fastMode: this.fastMode };
  }

  protected markExplicitSelection() {
    this.explicitSelection = true;
    this.restoredSelection = false;
  }

  protected retireModelSelection(restoredOnly: boolean): boolean {
    if (restoredOnly && !this.restoredSelection) {
      return false;
    }
    this.restoredSelection = false;
    this.explicitSelection = false;
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

  protected persistSelection(agentRuntime = this.agentRuntime) {
    this.onSelectionChange({
      model: this.selected,
      ...(agentRuntime !== undefined ? { agentRuntime } : {}),
      thinkingLevel: this.thinkingLevel,
      fastMode: this.fastMode,
    });
  }
}
