import { For } from "solid-js";
import { pathForAgentPanel } from "../../app-route-paths.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { AgentUtilityOverride } from "./data.ts";

/** Names the agents whose own utility settings win over the default, linking to each Overview. */
export function UtilityOverrides(props: {
  overrides: AgentUtilityOverride[];
  basePath: string;
  onOpen: (agentId: string) => void;
}) {
  const selection = (entry: AgentUtilityOverride) =>
    [
      entry.model === undefined
        ? t("modelProviders.defaults.utilityOverrideDefaultModel")
        : entry.model || t("modelProviders.defaults.disabled"),
      ...(entry.fallbacks.length
        ? [
            t("modelProviders.defaults.utilityOverrideFallbacks", {
              models: entry.fallbacks.join(", "),
            }),
          ]
        : []),
    ].join(" · ");
  return (
    <span>
      {t("modelProviders.defaults.utilityOverridesTitle")}
      <For each={props.overrides}>
        {(entry) => (
          <span data-agent-id={entry.agentId}>
            <br />
            <a
              class="model-providers__agent-link"
              href={pathForAgentPanel(entry.agentId, null, props.basePath)}
              onClick={(event) => handleNavigationClick(event, () => props.onOpen(entry.agentId))}
            >
              {entry.label}
            </a>
            {`: ${selection(entry)}`}
          </span>
        )}
      </For>
      <br />
      {t("modelProviders.defaults.utilityOverridesOthers")}
    </span>
  );
}
