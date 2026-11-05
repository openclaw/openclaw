import { For, Show, createMemo } from "solid-js";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerProcessesEnglish } from "../../../i18n/locales/en-processes.ts";
import { registerSessionOrganizationEnglish } from "../../../i18n/locales/en-session-organization.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createKeyedListMotion } from "../../../lib/reactive/keyed-list-motion.ts";
import type { ProcessesPanelData } from "../processes-panel-data.ts";
import { ChatDetailsProcessRow } from "./chat-details-process-row.tsx";
import type { createProcessesPresentation } from "./chat-processes-presentation.ts";

registerEnglishCatalog(registerChatSessionEnglish);
registerEnglishCatalog(registerChatDetailsEnglish);

registerEnglishCatalog(registerProcessesEnglish);
registerEnglishCatalog(registerSessionOrganizationEnglish);

export type ChatDetailsMobileProcessesProps = {
  /** The session host retains the native ProcessesPanelData projection and its demand. */
  data: Pick<
    ProcessesPanelData["snapshot"],
    "rows" | "error" | "errorKind" | "loading" | "hasResult"
  > &
    Pick<ProcessesPanelData, "refresh"> & {
      presentation: ReturnType<typeof createProcessesPresentation>;
    };
  presented: boolean;
  onOpen?: (instanceId?: string) => void;
};

/** Two native process rows; the existing host opens the complete collection. */
export function ChatDetailsMobileProcesses(props: ChatDetailsMobileProcessesProps) {
  const visibleRows = createMemo(() => props.data.rows.slice(0, 2));
  const hidden = () => props.data.rows.length - visibleRows().length;
  const error = () => (props.data.errorKind !== "read" ? props.data.error : null);
  const hasContent = () => props.data.rows.length > 0 || Boolean(error());
  const motion = createKeyedListMotion({
    ids: () => visibleRows().map((row) => row.instanceId),
    scope: () => props.data.presentation.scope(),
    ready: () => props.data.hasResult,
    active: () => props.presented && props.data.errorKind !== "access",
  });
  return (
    <Show when={motion.present() || error()}>
      <div ref={motion.shell} class="chat-details-processes__envelope">
        <div ref={motion.content} class="chat-details-processes__motion-content">
          <Show when={hasContent()}>
            <section
              class="chat-details-mobile-root__section"
              data-details-group="processes"
              aria-label={t("chat.sessionDetails.processes")}
            >
              <h3 class="chat-details-mobile-root__heading">
                {t("chat.sessionDetails.processes")}
              </h3>
              <div class="chat-details-mobile-root__group chat-details-mobile-processes">
                <Show when={error()}>
                  <div class="chat-details-mobile-processes__error" role="alert">
                    <span>{error()}</span>
                    <button
                      type="button"
                      class="chip"
                      disabled={!props.presented || props.data.loading}
                      onClick={() => void props.data.refresh()}
                    >
                      {t("common.retry")}
                    </button>
                  </div>
                </Show>
                <Show when={props.data.rows.length > 0}>
                  <div role="list" aria-label={t("chat.sessionDetails.processes")}>
                    <For each={visibleRows()} keyed={(row) => row.instanceId}>
                      {(row) => (
                        <ChatDetailsProcessRow
                          presentation={props.data.presentation}
                          row={row()}
                          elementRef={motion.row}
                          disabled={!props.presented}
                          onOpen={props.onOpen}
                        />
                      )}
                    </For>
                  </div>
                  <Show when={props.onOpen}>
                    <button
                      type="button"
                      class="chat-details-mobile-root__entry chat-details-mobile-processes__show-all"
                      disabled={!props.presented}
                      onClick={() => props.onOpen?.()}
                    >
                      <span class="chat-details-mobile-root__copy">
                        {hidden() > 0
                          ? t("chat.sessionDetails.showMore", { count: String(hidden()) })
                          : t("chat.processesPanel.viewAll")}
                      </span>
                    </button>
                  </Show>
                </Show>
              </div>
            </section>
          </Show>
        </div>
      </div>
    </Show>
  );
}
