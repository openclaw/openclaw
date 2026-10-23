import { For, Show } from "solid-js";
import type { McpAppResourceLink } from "../../../src/shared/mcp-app-extensions.js";
import { t } from "../lib/reactive/i18n.ts";

export function McpAppResourceResults(props: {
  resources: McpAppResourceLink[];
  disabled: boolean;
  onAttach: (resource: McpAppResourceLink) => void;
}) {
  return (
    <>
      <div class="mcp-app-resources__results">
        <For each={props.resources}>
          {(resource) => (
            <button
              type="button"
              class="btn mcp-app-resources__result"
              disabled={props.disabled}
              onClick={() => props.onAttach(resource)}
            >
              <span>{resource.title || resource.name}</span>
              <small>{resource.description || resource.uri}</small>
            </button>
          )}
        </For>
      </div>
      <Show when={!props.resources.length}>
        <p role="status">{t("mcpApp.noResources")}</p>
      </Show>
    </>
  );
}
