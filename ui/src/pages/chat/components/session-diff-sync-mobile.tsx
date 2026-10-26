import { createSignal, Show, useContext } from "solid-js";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createScrollStateRef } from "../../../lib/reactive/scroll-state.ts";
import "../../../styles/chat/session-diff-sync-mobile.css";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";

registerEnglishCatalog(registerChatSessionEnglish);

export type SessionDiffSyncMobileData = {
  /** Already quoted and assembled by the native diff owner, using this root and branch. */
  command: string;
  root: string;
  branch: string;
};

/** Body below the mobile host's Sync title/Back rail; owns no navigation or Git operation. */
export function SessionDiffSyncMobile(props: {
  /** Null when the native owner cannot offer Sync. Never substitute the selected commit. */
  data: SessionDiffSyncMobileData | null;
}) {
  const available = () => {
    const data = props.data;
    return data?.root && data.branch && data.command ? data : null;
  };
  return <Show when={available()}>{(data) => <SyncContent data={data()} />}</Show>;
}

function SyncMetadata(props: { icon: IconName; label: string; copyLabel: string; value: string }) {
  return (
    <div class="session-diff-sync-mobile__metadata-row">
      <Icon name={props.icon} />
      <div class="session-diff-sync-mobile__metadata-value">
        <div class="session-diff-sync-mobile__label">{props.label}</div>
        <code>{props.value}</code>
      </div>
      <CopyButton text={props.value} idleLabel={props.copyLabel} bare />
    </div>
  );
}

function SyncContent(props: { data: SessionDiffSyncMobileData }) {
  // Sync wrapping is local presentation, independent of saved diff preferences.
  const [wrap, setWrap] = createSignal(false);
  const [scroll, setScroll] = createSignal({ atStart: true, atEnd: true });
  const presented = useContext(ContentPresentation);
  const commandRef = createScrollStateRef((_, state) => setScroll(state), {
    horizontal: true,
    presented,
    content: () => [props.data.command, wrap()],
  });
  const wrapLabel = () =>
    t(wrap() ? "chat.sessionDiff.disableWrapping" : "chat.sessionDiff.enableWrapping");

  return (
    <div class="session-diff-sync-mobile">
      <p class="session-diff-sync-mobile__description">
        {t("chat.sessionDiff.syncDescription")} {t("chat.sessionDiff.uncommittedStay")}
      </p>
      <section
        class="session-diff-sync-mobile__command"
        aria-label={t("chat.sessionDiff.syncCommandLabel")}
      >
        <div class="session-diff-sync-mobile__command-header">
          <Icon name="terminal" />
          <span>{t("chat.sessionDiff.syncCommandLabel")}</span>
          <div class="session-diff-sync-mobile__actions">
            <openclaw-tooltip prop:content={wrapLabel()}>
              <button
                type="button"
                class="session-diff-sync-mobile__wrap"
                aria-label={wrapLabel()}
                aria-pressed={wrap() ? "true" : "false"}
                onClick={() => setWrap((value) => !value)}
              >
                <Icon name="wrapText" />
              </button>
            </openclaw-tooltip>
            <CopyButton
              text={props.data.command}
              idleLabel={t("chat.sessionDiff.copyCommand")}
              bare
            />
          </div>
        </div>
        <div
          class="session-diff-sync-mobile__viewport"
          data-wrap={wrap() ? "true" : "false"}
          data-at-start={scroll().atStart ? "true" : "false"}
          data-at-end={scroll().atEnd ? "true" : "false"}
        >
          <pre
            ref={commandRef}
            dir="ltr"
            tabindex={0}
            aria-label={t("chat.sessionDiff.syncCommandLabel")}
          >
            <code>{props.data.command}</code>
          </pre>
          <span class="session-diff-sync-mobile__fade-start" aria-hidden="true" />
          <span class="session-diff-sync-mobile__fade-end" aria-hidden="true" />
        </div>
      </section>
      <div class="session-diff-sync-mobile__metadata">
        <SyncMetadata
          icon="folder"
          label={t("chat.sessionDiff.checkoutPath")}
          copyLabel={t("chat.sessionHeader.copyPath")}
          value={props.data.root}
        />
        <SyncMetadata
          icon="gitBranch"
          label={t("chat.sessionDiff.branchName")}
          copyLabel={t("chat.sessionHeader.copyBranch")}
          value={props.data.branch}
        />
      </div>
    </div>
  );
}
