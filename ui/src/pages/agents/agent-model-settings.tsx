import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { normalizeAgentModelRefForConfig } from "../../../../src/config/model-input.js";
import type { AgentsListResult } from "../../api/types.ts";
import { MultiSelect } from "../../components/multi-select.tsx";
import {
  ModelSettingsRows,
  speedLabel,
  type FallbackSetting,
} from "../../components/solid/model-settings-rows.tsx";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import {
  resolveAgentConfig,
  resolveModelPrimary,
  resolveModelFallbacks,
} from "../../lib/agents/display.ts";
import {
  createAgentModelOptions,
  createPrimaryModelExclusion,
} from "../../lib/agents/model-options.ts";
import { buildQualifiedChatModelValue } from "../../lib/chat/model-ref.ts";
import { thinkingLevelLabel } from "../../lib/chat/thinking-level-label.ts";
import { resolveModelRuntimeEntry } from "../../lib/model-runtime-choice.ts";
import { modelSettingPrimary } from "../../lib/model-setting.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { createAgentConfigActions } from "./agent-config-actions.ts";
import type { AgentsPageView } from "./agents-page-state.ts";

type Props = Pick<
  AgentsPageView["overview"],
  "modelCatalog" | "decisionModels" | "onModelCatalogOpen"
> &
  ReturnType<typeof createAgentConfigActions>["models"] & {
    agent: AgentsListResult["agents"][number];
    configForm: Record<string, unknown> | null;
    modelConfigForm: Record<string, unknown> | null;
    canUpdate: boolean;
    notice?: JSX.Element;
  };
const INHERIT_UTILITY = "__openclaw_inherit_utility__";
const INHERIT_SUBAGENT = "__openclaw_inherit_subagent__";
function inheritLabel(value?: string | null) {
  return value
    ? t("agents.overview.inheritDefaultModel", { model: value })
    : t("agents.overview.inheritDefault");
}
export function AgentModelSettings(props: Props) {
  const id = () => props.agent.id;
  const config = createMemo(() => resolveAgentConfig(props.modelConfigForm, id()));
  // A restricted catalog owns model choices, but does not hide the agent's effort preference.
  const behavior = createMemo(() => resolveAgentConfig(props.configForm, id()));
  const disabled = () => !props.canUpdate || !props.modelConfigForm;
  const ownPrimary = () => resolveModelPrimary(config().entry?.model);
  const globalPrimary = () => resolveModelPrimary(config().defaults?.model);
  // The roster can display a read-only effective model. It cannot name the shared default
  // when a local override was just cleared and the roster still reports the old selection.
  const effectivePrimary = () =>
    ownPrimary() ?? globalPrimary() ?? resolveModelPrimary(props.agent.model);
  const catalogEntry = createMemo(() => {
    const ref = effectivePrimary();
    return props.modelCatalog.find(
      (model) => buildQualifiedChatModelValue(model.id, model.provider) === ref,
    );
  });
  // A draft can switch to a new catalog model before the roster publishes its new runtime and effort.
  const rosterDescribesModel = () =>
    !catalogEntry() ||
    !props.agent.model?.primary ||
    props.agent.model.primary === effectivePrimary();
  const primaryEntry = createMemo(() =>
    resolveModelRuntimeEntry(
      catalogEntry(),
      rosterDescribesModel() ? props.agent.agentRuntime?.id : undefined,
    ),
  );
  const utility = () => config().entry?.utilityModel;
  const globalUtility = () => config().defaults?.utilityModel;
  const utilityValue = () => modelSettingPrimary(utility() ?? null);
  const inheritedUtility = () => modelSettingPrimary(globalUtility() ?? null);
  const subagent = () => resolveModelPrimary(config().entry?.subagents?.model);
  const modelOptions = createMemo(() =>
    createAgentModelOptions(props.modelConfigForm, props.modelCatalog, id()),
  );
  const primaryOptions = createMemo(() => [
    {
      value: "",
      label: props.modelConfigForm ? inheritLabel(globalPrimary()) : t("agents.overview.notSet"),
    },
    ...modelOptions().withCurrent(effectivePrimary()),
  ]);
  const utilityOptions = createMemo(() => [
    {
      value: INHERIT_UTILITY,
      label: inheritLabel(
        (inheritedUtility() ?? t("agents.overview.utilityModelInheritAutomatic")) ||
          t("modelProviders.defaults.disabled"),
      ),
    },
    { value: "", label: t("agents.overview.utilityModelDisabled") },
    ...modelOptions().withCurrent(utilityValue()),
  ]);
  const subagentOptions = createMemo(() => [
    {
      value: INHERIT_SUBAGENT,
      label: inheritLabel(resolveModelPrimary(config().defaults?.subagents?.model)),
    },
    ...modelOptions().withCurrent(subagent()),
  ]);
  const thinking = () => behavior().entry?.thinkingDefault;
  const effortDefaultLabel = () => {
    // The roster resolves per-model params and clamping. Its active override is not the inherited level.
    if (!props.configForm) {
      return thinkingLevelLabel(t, props.agent.thinkingDefault ?? "");
    }
    if (!rosterDescribesModel()) {
      return inheritLabel();
    }
    const inherited =
      props.agent.thinkingInheritedDefault ??
      (!thinking() ? props.agent.thinkingDefault : undefined);
    return inheritLabel(inherited ? thinkingLevelLabel(t, inherited) : null);
  };
  const speedDefaultLabel = () => {
    const global = behavior().defaults?.fastModeDefault;
    return inheritLabel(global === undefined ? null : speedLabel(global));
  };

  function fallbacks(field: "model" | "utilityModel"): FallbackSetting {
    const chat = field === "model";
    const label = () =>
      t(chat ? "modelProviders.defaults.fallback" : "modelProviders.defaults.utilityFallback");
    const own = createMemo(() => resolveModelFallbacks(config().entry?.[field]));
    // An explicit primary without fallbacks is strict in both scopes: removing the chain
    // uses no fallbacks, not the global chain. A fallbacks-only override inherits the primary.
    const strict = () => (chat ? Boolean(ownPrimary()) : utilityValue() !== undefined);
    const inherited = createMemo(() =>
      strict()
        ? []
        : (resolveModelFallbacks(config().defaults?.[field]) ??
          (chat && !props.modelConfigForm ? props.agent.model?.fallbacks : undefined) ??
          []),
    );
    const chain = createMemo(() => own() ?? inherited());
    const primary = () =>
      chat ? effectivePrimary() : (utilityValue() ?? inheritedUtility() ?? null);
    const excluded = createMemo(() =>
      createPrimaryModelExclusion(props.modelConfigForm, primary(), id()),
    );
    const write = (values: string[] | null) =>
      chat
        ? props.onModelFallbacksChange(id(), values)
        : props.onUtilityFallbacksChange(id(), values);
    const blocked = () => disabled() || (!chat && primary() === "");
    const picks = createMemo(() => {
      const tail = new Set(chain().slice(1));
      return modelOptions()
        .withCurrent(own()?.[0])
        .filter((option) => !tail.has(option.value) || option.value === chain()[0]);
    });
    return {
      get fallbacks() {
        return chain();
      },
      get options() {
        return picks();
      },
      get isExcluded() {
        return excluded();
      },
      get disabled() {
        return blocked();
      },
      get inherit() {
        const models = inherited().join(", ") || t("modelProviders.defaults.noFallback");
        return {
          selected: own() === null,
          label: strict()
            ? t("agents.overview.automaticFallbacks", { models })
            : inheritLabel(models),
          reset: () => write(null),
        };
      },
      onOpen: () => props.onModelCatalogOpen(),
      onChange: (value) => write(value === null ? [] : [value, ...chain().slice(1)]),
      chainEditor: () => (
        <MultiSelect
          class={chat ? "agent-fallbacks" : "agent-utility-fallbacks"}
          options={modelOptions().options}
          value={chain()}
          isExcluded={excluded()}
          getValueKey={normalizeAgentModelRefForConfig}
          placeholder={t("agents.overview.addFallback")}
          accessibleLabel={label()}
          allowCustom={Boolean(props.modelConfigForm)}
          disabled={blocked()}
          onChange={write}
          onOpen={() => props.onModelCatalogOpen()}
        />
      ),
    };
  }
  const fallback = fallbacks("model");
  const utilityFallback = fallbacks("utilityModel");
  const picker = () => ({ disabled: disabled(), onOpen: props.onModelCatalogOpen });
  return (
    <SettingsSection
      title={t("agents.overview.modelSelection")}
      description={t("agents.overview.modelSelectionHelp")}
      notice={props.notice}
    >
      <ModelSettingsRows
        scope="agent"
        model={primaryEntry()}
        thinkingLevels={
          (rosterDescribesModel() ? props.agent.thinkingLevels : undefined) ??
          primaryEntry()?.thinkingLevels
        }
        primary={{
          ...picker(),
          id: "agent-primary-model",
          value: (props.modelConfigForm ? ownPrimary() : effectivePrimary()) ?? "",
          options: primaryOptions(),
          title: effectivePrimary() ?? undefined,
          onChange: (value) => props.onModelChange(id(), value || null),
        }}
        thinking={{
          value: thinking(),
          overridden: thinking() !== undefined,
          defaultLabel: effortDefaultLabel(),
          disabled: !props.canUpdate || !props.configForm,
          onChange: (value) => props.onThinkingDefaultChange(id(), value),
          onReset: () => props.onThinkingDefaultChange(id(), null),
        }}
        speed={{
          value: behavior().entry?.fastModeDefault,
          overridden: behavior().entry?.fastModeDefault !== undefined,
          defaultLabel: speedDefaultLabel(),
          disabled: !props.canUpdate || !props.configForm,
          onChange: (value) => props.onFastModeDefaultChange(id(), value),
          onReset: () => props.onFastModeDefaultChange(id(), null),
        }}
        hasAdvanced={
          resolveModelFallbacks(config().entry?.model) !== null ||
          config().entry?.subagents?.model !== undefined ||
          utility() !== undefined ||
          config().entry?.decisionModel !== undefined
        }
        fallback={fallback}
        utilityFallback={utilityFallback}
        subagent={{
          ...picker(),
          id: "agent-subagent-model",
          value: subagent() ?? INHERIT_SUBAGENT,
          options: subagentOptions(),
          title: subagent() ?? undefined,
          onChange: (value) =>
            props.onSubagentModelChange(id(), value === INHERIT_SUBAGENT ? null : value),
        }}
        utility={{
          ...picker(),
          id: "agent-utility-model",
          value: utilityValue() ?? INHERIT_UTILITY,
          options: utilityOptions(),
          title: utilityValue() || undefined,
          onChange: (value) =>
            props.onUtilityModelChange(id(), value === INHERIT_UTILITY ? null : value),
        }}
        decision={{
          ...picker(),
          id: "agent-decision-model",
          models: props.decisionModels,
          value: config().entry?.decisionModel,
          inherit: { model: config().defaults?.decisionModel },
          onChange: (value) => props.onDecisionModelChange(id(), value),
        }}
      />
    </SettingsSection>
  );
}
