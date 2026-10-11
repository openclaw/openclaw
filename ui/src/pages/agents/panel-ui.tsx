import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";

export function AgentPanelAction(props: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button class="btn btn--sm" disabled={props.disabled} onClick={() => props.onClick()}>
      {props.label}
    </button>
  );
}

export function renderAgentPanelFacts(
  facts: ReadonlyArray<readonly [string, string | JSX.Element] | null>,
) {
  return (
    <dl class="settings-kv">
      <For each={facts}>
        {(fact) =>
          fact ? (
            <>
              <dt>{t(fact[0])}</dt>
              <dd>{fact[1]}</dd>
            </>
          ) : undefined
        }
      </For>
    </dl>
  );
}
