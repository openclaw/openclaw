import { Show } from "solid-js";
import type { ProviderPresentation } from "../../../components/provider-icon-data.ts";
import { ProviderBrandIcon } from "../../../components/solid/provider-icon.tsx";

export function ChatModelBrandIcon(props: {
  provider: string;
  maker?: string;
  presentation?: ProviderPresentation;
  class: string;
}) {
  return (
    <Show
      when={props.maker}
      fallback={
        <ProviderBrandIcon
          provider={props.provider}
          presentation={props.presentation}
          class={props.class}
        />
      }
    >
      {(maker) => (
        <span class={[props.class, "chat-controls__routed-brand"]} aria-hidden="true">
          <span class="chat-controls__routed-brand-maker">
            <ProviderBrandIcon provider={maker()} />
          </span>
          <ProviderBrandIcon
            provider={props.provider}
            presentation={props.presentation}
            class="chat-controls__routed-brand-badge"
          />
        </span>
      )}
    </Show>
  );
}
