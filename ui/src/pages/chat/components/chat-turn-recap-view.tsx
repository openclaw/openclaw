import { Show } from "solid-js";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { formatDurationLong } from "../../../lib/format-duration.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { themeBrandingProjection } from "../../../lib/reactive/theme-branding.ts";
import type { TurnRecap } from "../chat-progress.ts";
import { outputTokensLabel, WorkingBrandGlyph } from "./chat-working-indicator-branding.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

export function TurnRecapRow(props: {
  recap: TurnRecap;
  hideDuration?: boolean;
  presentation?: "standalone" | "continuation";
}) {
  const branding = themeBrandingProjection;
  const duration = () =>
    formatDurationLong(Math.max(1, Math.round(props.recap.runtimeMs / 1_000)) * 1_000) ?? "";
  return (
    <Show when={!props.hideDuration || typeof props.recap.outputTokens === "number"}>
      <div
        class={[
          "chat-turn-recap",
          { "chat-turn-recap--continuation": props.presentation === "continuation" },
        ]}
        role="status"
      >
        <Show when={props.presentation !== "continuation"}>
          <span class="chat-turn-recap__claw" aria-hidden="true">
            <WorkingBrandGlyph branding={branding.read()} claw="claw" />
          </span>
        </Show>
        <Show when={typeof props.recap.outputTokens === "number"}>
          <span>{outputTokensLabel(props.recap.outputTokens!)}</span>
          <Show when={!props.hideDuration}>
            <span class="chat-turn-recap__sep" aria-hidden="true">
              ·
            </span>
          </Show>
        </Show>
        <Show when={!props.hideDuration}>
          <span>{t("chat.turnRecap.doneIn", { duration: duration() })}</span>
        </Show>
      </div>
    </Show>
  );
}
