import { createMemo, Show } from "solid-js";
import { normalizeSessionColorValue } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { t } from "../lib/reactive/i18n.ts";

export function SessionColorDot(props: { value: string | null | undefined }) {
  const color = createMemo(() => normalizeSessionColorValue(props.value ?? ""));
  return (
    <Show when={color()}>
      {(value) => (
        <span
          class="session-color-dot"
          style={{ "--session-color": `var(--session-color-${value()})` }}
          role="img"
          aria-label={t("sessionsView.sessionColor", {
            color: t(`sessionsView.colors.${value()}`),
          })}
        />
      )}
    </Show>
  );
}
