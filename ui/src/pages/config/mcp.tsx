import { createMemo } from "@solidjs/signals";
import type { JSX } from "@solidjs/web";
import { McpServersCard } from "../../components/mcp-servers-card.tsx";
import {
  LearnMoreLink,
  SettingsPage,
  SettingsRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerMcpEnglish } from "../../i18n/locales/en-mcp.ts";
import { summarizeMcpServers } from "../../lib/config/mcp-servers.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { SettingsSectionHeader } from "./settings-section-header.tsx";

registerEnglishCatalog(registerMcpEnglish);

const MCP_DOCS_URL = "https://docs.openclaw.ai/tools/mcp";

export type McpViewProps = {
  configObject: Record<string, unknown>;
  pluginsHref: string;
  /** Embedded schema editor; it owns autosave status and the restart banner. */
  editor: JSX.Element;
};

export function McpIntro() {
  return (
    <>
      {t("mcpPage.intro")} <LearnMoreLink url={MCP_DOCS_URL} />
    </>
  );
}

export function Mcp(props: McpViewProps) {
  const rows = createMemo(() => summarizeMcpServers(props.configObject) ?? []);
  return (
    <section class="mcp-page">
      <SettingsPage>
        <section class="settings-section mcp-page__summary">
          <SettingsSectionHeader title={t("mcpPage.servers")} />
          <div class="settings-group">
            <SettingsRow
              title={t("mcpPage.servers")}
              control={<SettingsValue value={rows().length} />}
            />
            <SettingsRow
              title={t("common.enabled")}
              control={<SettingsValue value={rows().filter((row) => row.enabled).length} />}
            />
            <SettingsRow
              title={t("mcpPage.oauth")}
              control={
                <SettingsValue value={rows().filter((row) => row.auth === "oauth").length} />
              }
            />
            <SettingsRow
              title={t("mcpPage.filtered")}
              control={<SettingsValue value={rows().filter((row) => row.toolFilter).length} />}
            />
          </div>
        </section>
        <section class="settings-section">
          <SettingsSectionHeader title={t("mcpPage.operatorCommands")} />
          <p class="settings-section__desc">{t("mcpPage.operatorCommandsHint")}</p>
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
        <McpServersCard pluginsHref={props.pluginsHref} docsUrl={MCP_DOCS_URL} />
      </SettingsPage>
      {props.editor}
    </section>
  );
}

export function renderMcpIntro() {
  return <McpIntro />;
}
export function renderMcp(props: McpViewProps) {
  return <Mcp {...props} />;
}
