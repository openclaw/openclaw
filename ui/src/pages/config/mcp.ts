import { html, type TemplateResult } from "lit";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";
import {
  renderLearnMoreLink,
  renderSettingsRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import "../../components/mcp-servers-card.ts";
import { t } from "../../i18n/index.ts";
import { registerMcpEnglish } from "../../i18n/locales/en-mcp.ts";
import { summarizeMcpServers } from "../../lib/config/mcp-servers.ts";
import { renderSettingsSectionHeader } from "./settings-section-header.ts";

registerMcpEnglish();

const MCP_DOCS_URL = "https://docs.openclaw.ai/tools/mcp";

type McpViewProps = {
  configObject: Record<string, unknown>;
  pluginsHref: string;
  /** Embedded schema editor; it owns autosave status and the restart banner. */
  editor: TemplateResult;
};

export function renderMcpIntro() {
  return html`${t("mcpPage.intro")} ${renderLearnMoreLink(MCP_DOCS_URL)}`;
}

export function renderMcp(props: McpViewProps) {
  const rows = summarizeMcpServers(props.configObject) ?? [];
  return html`
    <section class="mcp-page">
      <div class="settings-page" ${shellLayoutTraits({ settingsPage: true })}>
        <section class="settings-section mcp-page__summary">
          ${renderSettingsSectionHeader(t("mcpPage.servers"))}
          <div class="settings-group">
            ${(
              [
                ["mcpPage.servers", rows.length],
                ["common.enabled", rows.filter((row) => row.enabled).length],
                ["mcpPage.oauth", rows.filter((row) => row.auth === "oauth").length],
                ["mcpPage.filtered", rows.filter((row) => row.toolFilter).length],
              ] as const
            ).map(([label, count]) =>
              renderSettingsRow({ title: t(label), control: renderSettingsValue(count) }),
            )}
          </div>
        </section>

        <section class="settings-section">
          ${renderSettingsSectionHeader(t("mcpPage.operatorCommands"))}
          <p class="settings-section__desc">${t("mcpPage.operatorCommandsHint")}</p>
          <div class="settings-group">
            <div class="settings-row settings-row--stacked">
              <div class="mcp-command-card__grid">
                <code>openclaw mcp status --verbose</code>
                <code>openclaw mcp doctor --probe</code>
                <code>openclaw mcp login &lt;name&gt;</code>
                <code>openclaw mcp reload</code>
              </div>
            </div>
          </div>
        </section>

        <openclaw-mcp-servers-card
          .pluginsHref=${props.pluginsHref}
          .docsUrl=${MCP_DOCS_URL}
        ></openclaw-mcp-servers-card>
      </div>

      ${props.editor}
    </section>
  `;
}
