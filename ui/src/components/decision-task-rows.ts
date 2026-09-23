import { html, nothing, type TemplateResult } from "lit";
import { isDecisionTaskId, type DecisionTaskId } from "../../../src/decisions/task-ids.ts";
import type { ModelCatalogResult } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { renderDecisionModelPicker, type DecisionModelEntry } from "./decision-model-picker.ts";
import { renderSettingsRow } from "./settings-ui.ts";

export type DecisionTaskEntry = NonNullable<ModelCatalogResult["decisionTasks"]>[number];

type DecisionTaskSelectionSource = "agent-task" | "global-task" | "agent" | "default" | "none";

export type DecisionTaskSelection = {
  value: string | undefined;
  effectiveModel: string | undefined;
  source: DecisionTaskSelectionSource;
  disabled: boolean;
  inheritedModel?: string;
};

export type DecisionTaskConfig = {
  decisionModel?: unknown;
  decisionModelsByTask?: unknown;
};

function ownTaskValue(value: unknown, taskId: DecisionTaskId): string | undefined {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, taskId)) {
    return undefined;
  }
  // SAFETY: value is an object with this own key; the retrieved value remains unknown.
  const selected = (value as Record<string, unknown>)[taskId];
  return typeof selected === "string" ? selected : undefined;
}

function scalarValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Browser-safe mirror of src/agents/decision-model-setting.ts. The canonical
 * resolver imports the server-only agent-scope-config module, so keep this
 * precedence explicit and covered here rather than importing it into the UI.
 */
export function resolveDecisionTaskSelection(
  defaults: DecisionTaskConfig | undefined,
  entry: DecisionTaskConfig | undefined,
  taskId: DecisionTaskId,
): DecisionTaskSelection {
  const agentModel = scalarValue(entry?.decisionModel);
  const globalModel = scalarValue(defaults?.decisionModel);
  const agentTask = ownTaskValue(entry?.decisionModelsByTask, taskId);
  const globalTask = ownTaskValue(defaults?.decisionModelsByTask, taskId);
  const inheritedValue = globalTask ?? agentModel ?? globalModel;
  if (agentModel === "") {
    return {
      value: agentTask,
      effectiveModel: undefined,
      source: "agent",
      disabled: true,
      inheritedModel: undefined,
    };
  }
  if (agentTask !== undefined) {
    return {
      value: agentTask,
      effectiveModel: agentTask || undefined,
      source: "agent-task",
      disabled: agentTask === "",
      inheritedModel: inheritedValue || undefined,
    };
  }
  if (globalTask !== undefined) {
    return {
      value: undefined,
      effectiveModel: globalTask || undefined,
      source: "global-task",
      disabled: globalTask === "",
      inheritedModel: globalTask || undefined,
    };
  }
  const scalarSource: DecisionTaskSelectionSource =
    agentModel !== undefined ? "agent" : globalModel !== undefined ? "default" : "none";
  return {
    value: undefined,
    effectiveModel: inheritedValue || undefined,
    source: scalarSource,
    disabled: inheritedValue === "",
    inheritedModel: inheritedValue || undefined,
  };
}

export function resolveGlobalDecisionTaskSelection(
  defaults: DecisionTaskConfig | undefined,
  taskId: DecisionTaskId,
): DecisionTaskSelection {
  return {
    ...resolveDecisionTaskSelection(defaults, undefined, taskId),
    value: ownTaskValue(defaults?.decisionModelsByTask, taskId),
    inheritedModel: scalarValue(defaults?.decisionModel) || undefined,
  };
}

export function decisionTaskEntries(
  declared: readonly DecisionTaskEntry[],
  ...maps: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>
): Array<DecisionTaskEntry & { unavailable?: boolean }> {
  const entries = new Map<string, DecisionTaskEntry & { unavailable?: boolean }>(
    declared.filter((task) => task.id !== "decision_evaluate").map((task) => [task.id, task]),
  );
  for (const map of maps) {
    for (const taskId of Object.keys(map ?? {})) {
      if (isDecisionTaskId(taskId) && !entries.has(taskId)) {
        entries.set(
          taskId,
          taskId === "decision_evaluate"
            ? { id: taskId, title: t("chat.modelControls.decisionCoreOverride") }
            : { id: taskId, title: taskId, unavailable: true },
        );
      }
    }
  }
  return [...entries.values()];
}

function pickerId(prefix: string, taskId: DecisionTaskId): string {
  return `${prefix}-${encodeURIComponent(taskId)}`;
}

export function renderDecisionTaskRows(params: {
  scope: string;
  pickerPrefix: string;
  tasks: ReadonlyArray<DecisionTaskEntry & { unavailable?: boolean }>;
  models: readonly DecisionModelEntry[];
  disabled: boolean;
  getSelection: (taskId: DecisionTaskId) => DecisionTaskSelection;
  getInheritedLabel?: (selection: DecisionTaskSelection) => string;
  onChange: (taskId: DecisionTaskId, model: string | null) => void;
}): TemplateResult {
  const rows = params.tasks.map((task) => {
    const taskId = task.id;
    if (!isDecisionTaskId(taskId)) {
      return nothing;
    }
    const selection = params.getSelection(taskId);
    const inheritedModel = selection.inheritedModel;
    const inheritedLabel =
      params.getInheritedLabel?.(selection) ??
      t("chat.modelControls.decisionTaskInherit", {
        model: inheritedModel ?? t("chat.modelControls.decisionDisabled"),
      });
    const description =
      selection.source === "agent" && selection.disabled
        ? t("chat.modelControls.decisionTaskDisabledByAgent")
        : selection.disabled && selection.value === undefined && selection.source === "default"
          ? t("chat.modelControls.decisionTaskDisabledByDefault")
          : selection.disabled
            ? t("chat.modelControls.decisionTaskDisabled")
            : selection.source === "none"
              ? t("chat.modelControls.decisionTaskUnconfigured")
              : t(`chat.modelControls.decisionTaskSource.${selection.source}`);
    return html`<div data-decision-task-id=${taskId} data-decision-task-scope=${params.scope}>
      ${renderSettingsRow({
        title: task.title,
        description: task.unavailable
          ? t("chat.modelControls.decisionTaskUndeclared")
          : selection.disabled
            ? description
            : (task.description ?? description),
        control: renderDecisionModelPicker({
          id: pickerId(params.pickerPrefix, taskId),
          label: t("chat.modelControls.decisionTaskLabel", { task: task.title }),
          models: params.models,
          value: selection.value,
          inherit: {
            model: inheritedModel,
            label: inheritedLabel,
          },
          disabled: params.disabled || (selection.disabled && selection.source === "agent"),
          onChange: (model) => params.onChange(taskId, model),
        }),
      })}
    </div>`;
  });
  return html`${rows}`;
}
