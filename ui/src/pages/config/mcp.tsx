import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import {
  McpServersCard,
  type McpServerEditorRenderer,
} from "../../components/mcp-servers-card.tsx";
import { CopyButton } from "../../components/solid/copy-button.tsx";
import { SettingsDisclosure } from "../../components/solid/settings-disclosure.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { registerMcpEnglish } from "../../i18n/locales/en-mcp.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerMcpEnglish);

const MCP_DOCS_URL = "https://docs.openclaw.ai/tools/mcp";

const OPERATOR_COMMANDS = [
  "openclaw mcp status --verbose",
  "openclaw mcp doctor --probe",
  "openclaw mcp reload",
] as const;

export type McpViewProps = {
  /** Schema editor for what is not one server's; it owns autosave status and the restart banner. */
  editor: JSX.Element;
  renderServerEditor?: McpServerEditorRenderer;
};

export function Mcp(props: McpViewProps) {
  return (
    <section class="mcp-page">
      <SettingsPage>
        <McpServersCard docsUrl={MCP_DOCS_URL} renderEditor={props.renderServerEditor} />
      </SettingsPage>
      {props.editor}
      <SettingsPage>
        <SettingsDisclosure
          class="mcp-page__commands"
          title={t("mcpPage.operatorCommands")}
          description={t("mcpPage.operatorCommandsHint")}
        >
          <For each={OPERATOR_COMMANDS}>
            {(command) => (
              <div class="settings-row mcp-command">
                <code>{command}</code>
                <CopyButton text={command} idleLabel={t("common.copy")} iconFeedback />
              </div>
            )}
          </For>
        </SettingsDisclosure>
      </SettingsPage>
    </section>
  );
}
