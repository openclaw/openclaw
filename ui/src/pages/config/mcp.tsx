import { createMemo } from "@solidjs/signals";
import type { JSX } from "@solidjs/web";
import {
  LearnMoreLink,
  SettingsPage,
  SettingsRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import "../../components/mcp-servers-card.ts";
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
      {t("mcpPage.intro")} <LearnMoreLink href={MCP_DOCS_URL} />
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
              control={<SettingsValue>{rows().length}</SettingsValue>}
            />
            <SettingsRow
              title={t("common.enabled")}
              control={<SettingsValue>{rows().filter((row) => row.enabled).length}</SettingsValue>}
            />
            <SettingsRow
              title={t("mcpPage.oauth")}
              control={
                <SettingsValue>{rows().filter((row) => row.auth === "oauth").length}</SettingsValue>
              }
            />
            <SettingsRow
              title={t("mcpPage.filtered")}
              control={
                <SettingsValue>{rows().filter((row) => row.toolFilter).length}</SettingsValue>
              }
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
        <openclaw-mcp-servers-card
          prop:pluginsHref={props.pluginsHref}
          prop:docsUrl={MCP_DOCS_URL}
        />
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
