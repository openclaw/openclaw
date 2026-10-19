import { createMemo, For, Show } from "solid-js";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { Tooltip } from "../../components/solid/tooltip.tsx";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { ClawCatalogDetail } from "./claws-catalog-client.ts";

registerEnglishCatalog(registerAgentsHomeEnglish);

// Workspace roles use exact root-relative names; nested lookalikes are ordinary files.
const fileRoles = new Map<string, readonly [IconName, string]>([
  ["AGENTS.md", ["scrollText", "agents"]],
  ["SOUL.md", ["palette", "soul"]],
  ["USER.md", ["circleUser", "user"]],
  ["IDENTITY.md", ["bot", "identity"]],
  ["BOOT.md", ["play", "boot"]],
  ["BOOTSTRAP.md", ["flag", "bootstrap"]],
  ["MEMORY.md", ["brain", "memory"]],
  ["TOOLS.md", ["wrench", "tools"]],
  ["HEARTBEAT.md", ["activity", "heartbeat"]],
]);

function fileRole(name: string): readonly [IconName, string] {
  return (
    fileRoles.get(name) ??
    (/^memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(name)
      ? ["calendarClock", "dailyMemory"]
      : ["fileText", "generic"])
  );
}

export function ClawWorkspaceFiles(props: {
  files: ClawCatalogDetail["contents"]["instructions"];
  onOpen: (name: string) => void;
}) {
  const orderedFiles = createMemo(() => {
    const preferred = ["SOUL.md", "AGENTS.md"].flatMap((name) =>
      props.files.filter((file) => file.name === name),
    );
    return [...preferred, ...props.files.filter((file) => !preferred.includes(file))];
  });
  return (
    <Show when={props.files.length}>
      <section class="plugin-capabilities">
        <h2>
          {t("clawsCatalog.workspaceFiles")}
          <span>{props.files.length}</span>
        </h2>
        <div>
          <For each={orderedFiles()}>
            {(file) => (
              <div class="plugin-capability">
                <div class="plugin-capability__static claws-workspace-file">
                  <span class="plugin-capability__icon" aria-hidden="true">
                    <Icon name={fileRole(file.name)[0]} />
                  </span>
                  <div class="plugin-capability__copy">
                    <div class="claws-workspace-file__title">
                      <button
                        type="button"
                        class="claws-workspace-file__open"
                        onClick={() => props.onOpen(file.name)}
                      >
                        <strong>{file.name}</strong>
                      </button>
                      <Tooltip
                        content={t(`clawsCatalog.filePurpose.${fileRole(file.name)[1]}`)}
                        openOnClick
                      >
                        <button
                          type="button"
                          class="claws-workspace-file__info"
                          aria-label={t("clawsCatalog.aboutFile", { name: file.name })}
                        >
                          <Icon name="info" />
                        </button>
                      </Tooltip>
                    </div>
                    <Show when={file.excerpt}>
                      <span>{file.excerpt}</span>
                    </Show>
                  </div>
                  <span class="plugin-capability__chevron" aria-hidden="true">
                    <Icon name="chevronRight" />
                  </span>
                </div>
              </div>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}
