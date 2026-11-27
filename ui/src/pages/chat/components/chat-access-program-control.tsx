import { action, createMemo, createOptimistic, Show } from "solid-js";
import type { CyberAccessProgram } from "../../../api/types.ts";
import { Switch } from "../../../components/solid/switch.tsx";
import type { resolveDaybreakAccessProgram } from "../../../lib/chat/daybreak-access-program.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/settings-native-controls.css";

const programLabels = {
  daybreak_blue: "chat.modelControls.daybreakBlueShort",
  daybreak_red: "chat.modelControls.daybreakRedShort",
} as const;

export type ChatAccessProgramControlProps = {
  daybreak: ReturnType<typeof resolveDaybreakAccessProgram>;
  disabled: boolean;
  sessionKey: string;
  onSelect: (value: CyberAccessProgram, sessionKey: string) => unknown;
};

export function ChatAccessProgramControl(props: ChatAccessProgramControlProps) {
  const [saving, setSaving] = createOptimistic(false);
  const select = action(function* (...args: Parameters<ChatAccessProgramControlProps["onSelect"]>) {
    setSaving(true);
    yield props.onSelect(...args);
  });
  // Streamed snapshots must not reset native activation before the change event.
  const checked = createMemo(() => props.daybreak.checked);
  const disabled = createMemo(() => props.disabled || (props.daybreak.locked && checked()));
  const requiredHint = () =>
    props.daybreak.locked ? t("chat.modelControls.daybreakRequired") : undefined;
  return (
    <div class="chat-controls__access-panel">
      <div class="chat-controls__access-head" title={requiredHint()}>
        <span class="oc-menu-heading__label">
          {t("chat.modelControls.daybreak")}
          <Show when={checked() && props.daybreak.program}>
            {(program) => (
              <span class="chat-controls__access-caption">{t(programLabels[program()])}</span>
            )}
          </Show>
          <Show when={props.daybreak.remap !== undefined && requiredHint()}>
            <span class="chat-controls__access-hint" aria-hidden="true">
              {requiredHint()}
            </span>
          </Show>
        </span>
        <Switch
          size="sm"
          ariaLabel={t("chat.modelControls.daybreak")}
          ariaDescription={requiredHint()}
          checked={checked()}
          disabled={disabled()}
          saving={saving()}
          onChange={(nextChecked) => {
            const next = nextChecked ? props.daybreak.program : "standard";
            if (!next) {
              return false;
            }
            void select(next, props.sessionKey);
            return true;
          }}
        />
      </div>
    </div>
  );
}
