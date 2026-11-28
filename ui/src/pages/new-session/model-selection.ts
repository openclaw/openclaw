import { createChangeListeners } from "../../../../src/shared/listeners.js";
import type {
  CyberAccessProgram,
  FastMode,
  GatewayAgentRow,
  ModelCatalogEntry,
} from "../../api/types.ts";
import type { DurableDraftModelSelection } from "../../lib/chat/composer-draft-store.runtime.ts";
import { resolveDaybreakModelSwitch } from "../../lib/chat/daybreak-access-program.ts";
import {
  normalizeChatFastModeInput,
  type ChatFastModeSelectValue,
} from "../../lib/chat/model-select-state.ts";
import { normalizeThinkingOptionValue } from "../../lib/chat/thinking.ts";
import { selectableRuntimeId } from "../../lib/model-runtime-choice.ts";
import type { DraftCloudProfile } from "./discovery.ts";
import {
  reconcileDraftModelSelection,
  resolveDraftAccessProgram,
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
  selection: Pick<
    NewSessionPreference,
    "model" | "agentRuntime" | "thinkingLevel" | "fastMode" | "cyberAccessProgram"
  >,
) => void;

/** Mutable intent belongs to this draft, separate from remembered defaults and catalog metadata. */
export abstract class NewSessionModelSelection {
  abstract accessProgramForSubmission(): CyberAccessProgram | undefined;
  abstract resolveAgentRuntime(): ModelCatalogEntry["agentRuntime"];
  abstract hostedEnvironments(): Array<{ id: string; model?: string }>;
  abstract hostEnvironmentRuntime():
    | { model: string; runtime: NonNullable<ModelCatalogEntry["agentRuntime"]> }
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
    this.selectModel(choice.model, selectableRuntimeId(choice.runtime));
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
  protected selectionGeneration = 0;
  protected restoringPreference = false;
  protected pendingDraftSelection: DurableDraftModelSelection | undefined;
  onDraftSelectionChange: (() => void) | undefined;
  selected = "";
  agentRuntime: string | undefined;
  contextWindow = "";
  thinkingLevel = "";
  fastMode: FastMode | undefined;
  cyberAccessProgram: CyberAccessProgram | undefined;

  private readonly listeners = createChangeListeners();
  protected readonly notify = () => {
    this.listeners.publish();
    this.changed();
  };

  readonly subscribe = this.listeners.subscribe;

  constructor(
    private readonly onSelectionChange: ModelSelectionChange,
    private readonly changed: () => void,
  ) {}

  initializeAccessProgram(): void {
    const selected = this.accessProgramForSubmission();
    if (selected !== undefined && this.cyberAccessProgram !== selected) {
      this.cyberAccessProgram = selected;
      this.onSelectionChange({ cyberAccessProgram: selected });
    }
  }

  protected readonly selectThinkingLevel = (value: string) => {
    this.selectionGeneration += 1;
    this.restoringPreference = false;
    this.thinkingLevel = value;
    this.markExplicitSelection();
    this.persistSelection();
    this.onDraftSelectionChange?.();
    this.notify();
  };

  protected readonly selectFastMode = (value: ChatFastModeSelectValue) => {
    this.selectionGeneration += 1;
    this.restoringPreference = false;
    this.fastModeSelected = true;
    this.fastMode = normalizeChatFastModeInput(value);
    this.persistSelection();
    this.notify();
  };

  protected readonly selectAccessProgram = (value: CyberAccessProgram) => {
    this.selectionGeneration += 1;
    this.restoringPreference = false;
    this.cyberAccessProgram = value;
    this.markExplicitSelection();
    this.onSelectionChange({ cyberAccessProgram: value });
    this.onDraftSelectionChange?.();
    this.notify();
  };

  protected resetSelection(model = "") {
    this.selected = model;
    this.agentRuntime = undefined;
    this.contextWindow = "";
    this.thinkingLevel = "";
    this.fastMode = undefined;
    this.cyberAccessProgram = undefined;
    this.selectionOrigin = "none";
    this.fastModeSelected = false;
  }

  protected applyModelSelection(selection: ReturnType<typeof reconcileDraftModelSelection>) {
    const changed =
      this.selected !== selection.model ||
      this.agentRuntime !== selection.agentRuntime ||
      this.thinkingLevel !== selection.thinkingLevel ||
      this.fastMode !== selection.fastMode;
    this.selected = selection.model;
    this.agentRuntime = selection.agentRuntime;
    this.thinkingLevel = selection.thinkingLevel;
    this.fastMode = selection.fastMode;
    return changed;
  }

  draftSelection(agentId: string): DurableDraftModelSelection | undefined {
    return this.selectionOrigin !== "none"
      ? {
          agentId,
          model: this.selected,
          agentRuntime: this.agentRuntime,
          thinkingLevel: this.thinkingLevel,
          cyberAccessProgram: this.cyberAccessProgram,
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
        cyberAccessProgram: this.cyberAccessProgram ?? preference?.cyberAccessProgram,
        fastMode,
      };
    }
    const access = {
      cyberAccessProgram: preference?.cyberAccessProgram,
    };
    if (options.initialModel) {
      return {
        ...access,
        model: options.initialModelPending ? options.initialModel : this.selected,
        agentRuntime: this.agentRuntime,
        thinkingLevel: this.thinkingLevel,
        fastMode,
      };
    }
    return options.policy === "configured" || options.policy === null
      ? { fastMode, ...access }
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
    this.cyberAccessProgram = selection.cyberAccessProgram;
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
    this.cyberAccessProgram = undefined;
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
      return false;
    }
    const selection = reconcileDraftModelSelection({
      model: preference.model ?? "",
      agentRuntime: preference.agentRuntime,
      thinkingLevel: preference.thinkingLevel ?? "",
      fastMode: preference.fastMode,
      ...options,
    });
    const accessChanged = this.cyberAccessProgram !== preference.cyberAccessProgram;
    this.cyberAccessProgram = preference.cyberAccessProgram;
    const changed = this.applyModelSelection(selection) || accessChanged;
    if (selection.repaired && persistRepair) {
      this.persistSelection(preference.agentRuntime ? (this.agentRuntime ?? "") : undefined);
    }
    return changed;
  }

  protected selectModelIntent(
    model: string,
    agentRuntime: string | undefined,
    options: Omit<
      Parameters<typeof reconcileDraftModelSelection>[0],
      "model" | "agentRuntime" | "thinkingLevel" | "fastMode"
    >,
    effectiveModel: string,
    catalogReady: boolean,
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
    const target =
      resolveDraftModelTarget(
        selection.model,
        undefined,
        options.catalog,
        selection.agentRuntime,
      ) ?? resolveDraftDefaultModelTarget(options);
    if (catalogReady && target?.entry) {
      // Remap from the normalized program this draft displays and would submit.
      const current = resolveDraftAccessProgram({
        ...options,
        model: effectiveModel,
        agentRuntime: this.agentRuntime,
        requested: this.cyberAccessProgram,
      });
      const update = resolveDaybreakModelSwitch(
        target.entry.availableAccessPrograms?.cyber,
        current,
        this.cyberAccessProgram,
      );
      if (update !== undefined) {
        this.cyberAccessProgram = update ?? undefined;
      }
    }
    this.applyModelSelection(selection);
    this.markExplicitSelection();
    this.contextWindow = "";
    return { target, runtimeChanged };
  }

  protected persistSelection(agentRuntime = this.agentRuntime) {
    this.onSelectionChange({
      model: this.selected,
      ...(agentRuntime !== undefined ? { agentRuntime } : {}),
      thinkingLevel: this.thinkingLevel,
      fastMode: this.fastMode,
      ...(this.cyberAccessProgram === undefined
        ? {}
        : { cyberAccessProgram: this.cyberAccessProgram }),
    });
  }
}
