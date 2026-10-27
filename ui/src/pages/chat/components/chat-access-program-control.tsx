import { For, Show } from "solid-js";
import type { CyberAccessProgram } from "../../../api/types.ts";
import { DETAILS_SECTION_MOTION } from "../../../components/details-section-motion.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { SettingsToggle } from "../../../components/solid/settings-ui.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/settings-native-controls.css";

const programLabels = {
  daybreak_blue: "chat.modelControls.daybreakBlueShort",
  daybreak_red: "chat.modelControls.daybreakRedShort",
} as const;

export type ChatAccessProgramControlProps = {
  programs?: readonly CyberAccessProgram[];
  effectiveAccessProgram?: CyberAccessProgram;
  previous?: Exclude<CyberAccessProgram, "standard">;
  requested?: CyberAccessProgram;
  disabled: boolean;
  sessionKey: string;
  onSelect: (
    value: CyberAccessProgram,
    sessionKey: string,
    previous?: Exclude<CyberAccessProgram, "standard">,
  ) => unknown;
};

export function ChatAccessProgramControl(props: ChatAccessProgramControlProps) {
  const programs = () => (props.programs ?? []).filter((program) => program !== "standard");
  const selected = () => props.requested ?? props.effectiveAccessProgram;
  const enabled = () => selected() !== undefined && selected() !== "standard";
  const unavailable = () => {
    const current = selected();
    return props.programs !== undefined &&
      current &&
      current !== "standard" &&
      !programs().includes(current)
      ? current
      : undefined;
  };
  return (
    <Show when={programs().length > 0 || enabled()}>
      <div
        class="chat-controls__access-panel"
        style={{
          "--access-motion-duration": `${DETAILS_SECTION_MOTION.duration}ms`,
          "--access-motion-easing": DETAILS_SECTION_MOTION.easing,
        }}
      >
        <div class="chat-controls__access-head">
          <span class="chat-controls__effort-heading">{t("chat.modelControls.daybreak")}</span>
          <SettingsToggle
            ariaLabel={t("chat.modelControls.daybreak")}
            checked={enabled()}
            disabled={props.disabled}
            onChange={(checked) => {
              if (checked) {
                const next =
                  props.previous && programs().includes(props.previous)
                    ? props.previous
                    : programs()[0];
                if (next) {
                  void props.onSelect(next, props.sessionKey);
                }
              } else {
                const current = selected();
                void props.onSelect(
                  "standard",
                  props.sessionKey,
                  current !== "standard" ? current : undefined,
                );
              }
            }}
          />
        </div>
        <div
          class="chat-controls__access-choices"
          data-expanded={enabled() ? "true" : "false"}
          aria-hidden={enabled() ? "false" : "true"}
          inert={!enabled()}
        >
          <div class="chat-controls__access-clip">
            <div
              class="chat-controls__access-options"
              role="group"
              aria-label={t("chat.modelControls.daybreak")}
              data-chat-access-program="true"
            >
              <Show when={unavailable()}>
                <span class="chat-controls__access-option" aria-disabled="true">
                  {t("chat.modelControls.accessUnavailable", {
                    program:
                      selected() === "daybreak_red"
                        ? t(programLabels.daybreak_red)
                        : t(programLabels.daybreak_blue),
                  })}
                </span>
              </Show>
              <For each={programs()}>
                {(program) => (
                  <button
                    type="button"
                    class="chat-controls__access-option"
                    data-chat-access-option={program}
                    aria-pressed={selected() === program ? "true" : "false"}
                    disabled={props.disabled}
                    onClick={() => {
                      if (program !== selected()) {
                        void props.onSelect(program, props.sessionKey);
                      }
                    }}
                  >
                    <span>{t(programLabels[program])}</span>
                    <span class="chat-controls__access-check" aria-hidden="true">
                      <Icon name="check" />
                    </span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
