import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";

export function ChatActionCard(props: {
  icon: IconName;
  title: string;
  subtitle?: string;
  inline?: boolean;
  children: JSX.Element;
}) {
  return (
    <section class={["chat-permission-card", { filters: props.inline }]} aria-label={props.title}>
      <div class="chat-permission-card__heading">
        <Icon name={props.icon} />
        <Show when={props.subtitle} fallback={<strong>{props.title}</strong>}>
          {(subtitle) => (
            <div style="overflow-wrap:anywhere">
              <strong>{props.title}</strong>
              <br />
              <small class="muted">{subtitle()}</small>
            </div>
          )}
        </Show>
      </div>
      {props.children}
    </section>
  );
}
