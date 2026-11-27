import { createMemo, Show } from "solid-js";
import { resolveChatThinkingSelectState } from "../../lib/chat/thinking.ts";
import { getCronModelThinkingIncompatibility } from "../../lib/cron/model-thinking-validation.ts";
import { resolveModelCatalogState } from "../../lib/model-catalog-store.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { ChatModelControls } from "../chat/components/chat-model-controls.tsx";
import type { ChatModelControlsProps } from "../chat/components/chat-model-controls.types.ts";
import {
  reconcileDraftModelSelection,
  resolveDraftModelControls,
  type NewSessionModelMetadata,
} from "../new-session/model-target.ts";
import type { CronProps } from "./view-types.ts";
import "../../styles/chat/composer.css";

const SESSION_KEY = "cron-editor";
// Automation payloads carry a model and a reasoning level; speed, context window,
// access program and runtime stay with the agent's defaults.
const NO_FAST_MODE = { active: false, currentOverride: "", label: "", supported: false } as const;

/** The session composer's model and reasoning pickers, bound to the automation's payload. */
export function CronModelControls(
  props: Pick<
    CronProps,
    "form" | "connected" | "busy" | "canManage" | "onFormChange" | "models" | "editingJob"
  >,
) {
  const metadata = createMemo((): NewSessionModelMetadata => {
    const catalog = props.models.catalog;
    if (!catalog?.hasSnapshot) {
      return { catalog: [], hasSnapshot: false, status: "loading" };
    }
    return {
      ...resolveModelCatalogState(catalog, { retired: catalog.retired }),
      // Payloads cannot pin a runtime, so runtime variants are not choices here.
      catalog: catalog.models.map(({ runtimeChoices: _runtimeChoices, ...entry }) => entry),
    };
  });
  const controls = createMemo((): ChatModelControlsProps => {
    const model = props.form.payloadModel.trim();
    const thinkingLevel = props.form.payloadThinking.trim();
    const facts = metadata();
    const agent = props.models.agent;
    const {
      defaultTarget: _defaultTarget,
      contextWindowTarget: _contextWindowTarget,
      fastModeTarget: _fastModeTarget,
      ...draft
    } = resolveDraftModelControls({
      model,
      selection: { contextWindow: "", thinkingLevel },
      metadata: facts,
      agent,
    });
    const disabledReason = !props.canManage
      ? t("cron.adminRequired")
      : props.busy
        ? t("cron.form.saving")
        : undefined;
    return {
      ...draft,
      activeRunId: null,
      connected: props.connected,
      gatewayAvailable: props.connected,
      loading: false,
      modelCatalog: facts.catalog,
      modelOverrides: { [SESSION_KEY]: model || null },
      modelSwitching: false,
      modelMutationDisabledReason: disabledReason,
      effortMutationDisabledReason: disabledReason,
      contextWindowTarget: {},
      fastModeDisplay: NO_FAST_MODE,
      sending: false,
      sessionKey: SESSION_KEY,
      selectedSession: undefined,
      sessionsResult: null,
      stream: null,
      onModelSelect: (next) => {
        if (next === props.form.payloadModel.trim()) {
          return;
        }
        const current = metadata();
        // Like a new session's draft, a level the next model does not offer falls back to Default.
        const { thinkingLevel: payloadThinking } = reconcileDraftModelSelection({
          model: next,
          thinkingLevel: props.form.payloadThinking.trim(),
          agent: props.models.agent,
          catalog: current.catalog,
          modelSelectionPolicy: current.modelSelectionPolicy,
        });
        props.onFormChange({ payloadModel: next, payloadThinking });
      },
      onThinkingSelect: (next) => {
        // The model's own level is its Default, as the default model's row is in the model menu.
        const inherited = resolveChatThinkingSelectState({
          catalog: metadata().catalog,
          defaults: draft.thinkingDefaults,
          session: draft.thinkingSession,
          sessionKey: SESSION_KEY,
          sessionsResult: null,
        }).inherited.value;
        props.onFormChange({ payloadThinking: next === inherited ? "" : next });
      },
    };
  });
  const incompatiblePersistedSelection = createMemo(() => {
    const payload = props.editingJob?.payload;
    if (payload?.kind !== "agentTurn") {
      return undefined;
    }
    const incompatibility = getCronModelThinkingIncompatibility(props.form, props.models.catalog, {
      model: payload.model,
      thinking: payload.thinking,
    });
    if (incompatibility?.unchangedPersistedSelection) {
      return incompatibility;
    }
    return undefined;
  });
  return (
    <>
      <ChatModelControls {...controls()} />
      <Show when={incompatiblePersistedSelection()}>
        {(assessment) => (
          <span class="cron-help" role="status">
            {t("cron.errors.payloadThinkingUnsupportedExisting")}{" "}
            {assessment().supportedLevels.join(", ")}
          </span>
        )}
      </Show>
    </>
  );
}
