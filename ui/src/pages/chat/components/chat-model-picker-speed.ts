import { createSignal } from "solid-js";
import type { ChatAccountSelection } from "../../../../../packages/gateway-protocol/src/index.ts";
import type { ModelCatalogEntry } from "../../../api/types.ts";
import type { ChatFastModeSelectState } from "../../../lib/chat/model-select-state.ts";
import { resolveModelRuntimeEntry } from "../../../lib/model-runtime-choice.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatModelControlsProps } from "./chat-model-controls.types.ts";
import {
  isModelPickerOptionSelected,
  type ChatModelPickerOption,
  type ChatModelPickerSpeed,
  type PickerSpeedOverride,
} from "./chat-model-picker-options.ts";

type RememberedSpeed = Exclude<PickerSpeedOverride, null>;

function speedLabel(speed: RememberedSpeed | false): string {
  return speed === "ultrafast"
    ? t("chat.modelControls.ultrafast")
    : speed === "auto"
      ? t("chat.modelControls.automaticSpeed")
      : speed
        ? t("chat.modelControls.fast")
        : t("chat.modelControls.standard");
}

type PickerState = {
  scope?: string;
  account?: ChatAccountSelection | null;
  catalog: { entry: (value: string) => ModelCatalogEntry | undefined };
  activeModelOption?: ChatModelPickerOption;
  pickerValue: string;
  selectedAgentRuntime?: string;
  fastMode: ChatFastModeSelectState;
  speedOverride?: ModelCatalogEntry["effectiveFastMode"];
  disabled: boolean;
  select: ChatModelControlsProps["onModelSelect"];
};

function routeKey(state: PickerState, entry: ChatModelPickerOption): string {
  return JSON.stringify([
    entry.value,
    entry.agentRuntimeId ?? state.catalog.entry(entry.value)?.agentRuntime?.id,
    entry.provider === state.activeModelOption?.provider && state.account?.kind !== "automatic"
      ? state.account?.authProfileId
      : undefined,
  ]);
}

/** Presentation-only history for the live chat; never restores paid speed on a normal switch. */
export function createChatModelPickerSpeed(read: () => PickerState) {
  const [history, setHistory] = createSignal<{
    scope: string;
    choices: ReadonlyMap<string, RememberedSpeed>;
  }>();

  return {
    forModel(this: void, entry: ChatModelPickerOption): ChatModelPickerSpeed | undefined {
      const state = read();
      if (!state.scope || entry.disabled) {
        return undefined;
      }
      const route = resolveModelRuntimeEntry(state.catalog.entry(entry.value), entry.agentRuntime);
      if (isModelPickerOptionSelected(entry, state.pickerValue, state.selectedAgentRuntime)) {
        return route?.supportsFastMode === undefined && !state.fastMode.active
          ? undefined
          : { label: state.fastMode.active ? state.fastMode.label : speedLabel(false) };
      }
      const configured = route?.supportsFastMode === false ? false : route?.effectiveFastMode;
      const snapshot = history();
      const remembered =
        snapshot?.scope === state.scope ? snapshot.choices.get(routeKey(state, entry)) : undefined;
      const eligible =
        remembered !== undefined &&
        route?.supportsFastMode === true &&
        (remembered !== "ultrafast" || route.serviceTiers?.includes("ultrafast")) &&
        remembered !== configured;
      return {
        label:
          route?.supportsFastMode !== undefined || configured !== undefined
            ? speedLabel(configured ?? false)
            : undefined,
        useDefault: state.speedOverride !== undefined,
        lastUsed: eligible
          ? {
              value: remembered,
              label: speedLabel(remembered),
              disabled: state.disabled,
            }
          : undefined,
      };
    },
    async select(
      this: void,
      next: string,
      sessionKey: string,
      runtime?: string | null,
      speed?: PickerSpeedOverride,
    ) {
      const initial = read();
      const confirmed = await (speed === undefined
        ? initial.select?.(next, sessionKey, runtime)
        : initial.select?.(next, sessionKey, runtime, speed));
      const scope = initial.scope;
      if (confirmed !== true || !scope || !initial.activeModelOption || scope !== read().scope) {
        return confirmed;
      }
      const previous = routeKey(initial, initial.activeModelOption);
      const account = initial.account;
      setHistory((current) => {
        const choices = new Map(current?.scope === scope ? current.choices : []);
        choices.delete(previous);
        if (
          initial.fastMode.active &&
          initial.speedOverride &&
          (account?.kind !== "personal" || account.authProfileId)
        ) {
          choices.set(previous, initial.speedOverride);
          const oldest = choices.keys().next().value;
          if (choices.size > 16 && oldest !== undefined) {
            choices.delete(oldest);
          }
        }
        return { scope, choices };
      });
      return confirmed;
    },
  };
}
