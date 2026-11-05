import { createMemo, For, Show } from "solid-js";
import { TEMPLATE_BOOTSTRAP_FILE_NAMES } from "../../../../src/templates/manifest-contract.js";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { Tooltip } from "../../components/solid/tooltip.tsx";
import { registerTemplatesEnglish } from "../../i18n/locales/en-templates.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { TemplateCatalogDetail } from "./templates-catalog-client.ts";

registerEnglishCatalog(registerTemplatesEnglish);

// Match workspace destinations, never package-source basenames.
const agentDocuments = new Set<string>([
  ...TEMPLATE_BOOTSTRAP_FILE_NAMES,
  "BOOTSTRAP.md",
  "USER.md",
  "MEMORY.md",
]);

// Workspace roles use exact root-relative names; nested lookalikes are ordinary files.
const fileRoles = new Map<string, readonly [IconName, string]>([
  ["AGENTS.md", ["scrollText", "agents"]],
  ["SOUL.md", ["palette", "soul"]],
  ["USER.md", ["circleUser", "user"]],
  ["IDENTITY.md", ["bot", "identity"]],
  ["BOOTSTRAP.md", ["flag", "bootstrap"]],
  ["MEMORY.md", ["brain", "memory"]],
  ["TOOLS.md", ["wrench", "tools"]],
  ["HEARTBEAT.md", ["activity", "heartbeat"]],
]);

function fileRole(name: string): readonly [IconName, string] {
  return fileRoles.get(name) ?? ["fileText", "generic"];
}

export function TemplateWorkspaceFiles(props: {
  files: TemplateCatalogDetail["contents"]["instructions"];
  onOpen: (name?: string) => void;
}) {
  const documents = createMemo(() => props.files.filter((file) => agentDocuments.has(file.name)));
  const orderedFiles = createMemo(() => {
    const preferred = ["SOUL.md", "AGENTS.md"].flatMap((name) =>
      documents().filter((file) => file.name === name),
    );
    return [...preferred, ...documents().filter((file) => !preferred.includes(file))];
  });
  return (
    <Show when={props.files.length}>
      <div class="plugin-capabilities">
        <SettingsSection title={t("templatesCatalog.workspaceFiles")} carapace>
          <For each={orderedFiles()}>
            {(file) => (
              <div class="settings-row oc-settings-row templates-workspace-file">
                <span class="plugin-capability__icon" aria-hidden="true">
                  <Icon name={fileRole(file.name)[0]} />
                </span>
                <div class="settings-row__text oc-settings-row-content">
                  <div class="templates-workspace-file__title">
                    <button
                      type="button"
                      class="templates-workspace-file__open"
                      onClick={() => props.onOpen(file.name)}
                    >
                      <span class="settings-row__title oc-settings-row-title">{file.name}</span>
                    </button>
                    <Tooltip
                      content={t(`templatesCatalog.filePurpose.${fileRole(file.name)[1]}`)}
                      openOnClick
                    >
                      <button
                        type="button"
                        class="templates-workspace-file__info"
                        aria-label={t("templatesCatalog.aboutFile", { name: file.name })}
                      >
                        <Icon name="info" />
                      </button>
                    </Tooltip>
                  </div>
                  <Show when={file.excerpt}>
                    <span class="settings-row__desc oc-settings-row-description">
                      {file.excerpt}
                    </span>
                  </Show>
                </div>
                <div class="settings-row__control oc-settings-row-control">
                  <span class="settings-row__chevron" aria-hidden="true">
                    <Icon name="chevronRight" />
                  </span>
                </div>
              </div>
            )}
          </For>
          <Show when={documents().length < props.files.length}>
            <div class="settings-row oc-settings-row templates-workspace-file templates-workspace-file--all">
              <span class="plugin-capability__icon" aria-hidden="true">
                <Icon name="folder" />
              </span>
              <div class="settings-row__text oc-settings-row-content">
                <button
                  type="button"
                  class="templates-workspace-file__open"
                  onClick={() => props.onOpen()}
                >
                  <span class="settings-row__title oc-settings-row-title">
                    {t("templatesCatalog.viewAll")}
                  </span>
                </button>
              </div>
              <div class="settings-row__control oc-settings-row-control">
                <span class="settings-row__chevron" aria-hidden="true">
                  <Icon name="chevronRight" />
                </span>
              </div>
            </div>
          </Show>
        </SettingsSection>
      </div>
    </Show>
  );
}
