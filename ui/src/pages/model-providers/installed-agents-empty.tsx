import { Show } from "solid-js";
import { DocsLink, SettingsEmpty } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";

export function InstalledAgentsEmpty(props: { apps: readonly { name: string }[] }) {
  return (
    <SettingsEmpty
      message={
        <Show when={props.apps.length} fallback={t("modelProviders.installedAgents.empty")}>
          {t("modelProviders.installedAgents.notDetected", {
            names: props.apps.map((app) => app.name).join(", "),
          })}
          <br />
          <DocsLink url="https://docs.openclaw.ai/tools/acp-agents-setup#set-up-a-coding-app">
            {t("modelProviders.installedAgents.setupInstructions")}
          </DocsLink>
        </Show>
      }
    />
  );
}
