import { render as mountSolidContent, type JSX } from "@solidjs/web";
import { For } from "solid-js";
import { withPromiseModalHost } from "../../components/promise-modal-host.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";

export type PluginToolPreview = {
  name: string;
  description?: string;
  parameters?: Array<{ name: string; required: boolean; type?: string; description?: string }>;
};

export function showPluginToolPreview(tool: PluginToolPreview, signal: AbortSignal): Promise<void> {
  if (!tool.description?.trim() && !tool.parameters?.length) {
    return Promise.resolve();
  }
  return withPromiseModalHost<undefined, JSX.Element>(
    { signal, value: undefined },
    ({ render, finish }) => {
      render(() => (
        <openclaw-modal-dialog
          class="plugin-tool-dialog"
          label={tool.name}
          onModal-cancel={() => finish(undefined)}
        >
          <article class="plugin-tool-preview">
            <header>
              <h2>{tool.name}</h2>
              <button
                class="btn btn--icon"
                type="button"
                aria-label={t("common.close")}
                onClick={() => finish(undefined)}
              >
                <Icon name="x" />
              </button>
            </header>
            <div class="plugin-tool-preview__body">
              {tool.parameters?.length ? (
                <section class="plugin-tool-preview__parameters">
                  <h3>{t("pluginsPage.detailToolInputs")}</h3>
                  <dl>
                    <For each={tool.parameters}>
                      {(parameter) => (
                        <div>
                          <dt>
                            <code>{parameter.name}</code>
                            <span>
                              {t(
                                parameter.required
                                  ? "pluginsPage.detailRequired"
                                  : "pluginsPage.detailOptional",
                              )}
                            </span>
                            {parameter.type ? <span>{parameter.type}</span> : ""}
                          </dt>
                          {parameter.description ? <dd>{parameter.description}</dd> : ""}
                        </div>
                      )}
                    </For>
                  </dl>
                </section>
              ) : (
                ""
              )}
              {tool.description?.trim() ? <p>{tool.description}</p> : ""}
            </div>
          </article>
        </openclaw-modal-dialog>
      ));
    },
    mountSolidContent,
  );
}
