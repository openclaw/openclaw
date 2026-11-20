import type {
  SystemAgentChatHistoryResult,
  SystemChangesListResult,
} from "@openclaw/gateway-protocol";
import { createMemo, createSignal, Errored, For, Loading, onSettled, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  RetryAction,
  SettingsLoadingSkeleton,
} from "../../components/solid/settings-ui.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { SystemChangeHistory, type HistorySnapshot } from "./change-history.tsx";
import "../../styles/system-history.css";

registerEnglishCatalog(registerPluginManagementEnglish);
type HistoryScope = { client: GatewayBrowserClient; changes: boolean; transcript: boolean };

function HistoryContents(props: { scope: HistoryScope }) {
  const owner: { busy: boolean; retired: boolean; snapshot: HistorySnapshot } = {
    busy: false,
    retired: false,
    snapshot: { entries: [], nextCursor: null, error: null, loaded: false },
  };
  const [receipt, setReceipt] = createSignal<{
    reset: boolean;
    result: Promise<HistorySnapshot>;
  } | null>(null);
  function loadChanges(reset: boolean) {
    const scope = props.scope;
    const cursor = reset ? undefined : owner.snapshot.nextCursor;
    if (!scope.changes || owner.retired || owner.busy || (!reset && !cursor)) {
      return;
    }
    owner.busy = true;
    const completion = scope.client
      .request<SystemChangesListResult>("openclaw.changes.list", {
        limit: 50,
        ...(cursor ? { beforeCursor: cursor } : {}),
      })
      .then((result) => {
        if (!owner.retired) {
          owner.snapshot = {
            entries: reset ? result.entries : [...owner.snapshot.entries, ...result.entries],
            nextCursor: result.nextCursor ?? null,
            error: null,
            loaded: true,
          };
        }
        return owner.snapshot;
      })
      .catch((error: unknown) => {
        if (!owner.retired) {
          owner.snapshot = { ...owner.snapshot, error: formatUiError(error), loaded: true };
        }
        return owner.snapshot;
      })
      .finally(() => {
        owner.busy = false;
      });
    setReceipt({ reset, result: completion });
  }
  const transcript = createMemo(() =>
    props.scope.transcript
      ? props.scope.client.request<SystemAgentChatHistoryResult>("openclaw.chat.history", {
          limit: 200,
        })
      : Promise.resolve({ turns: [] }),
  );
  onSettled(() => {
    loadChanges(true);
    return () => {
      owner.retired = true;
    };
  });
  return (
    <>
      <Show when={props.scope.changes}>
        <SystemChangeHistory request={receipt()} previous={owner.snapshot} onLoad={loadChanges} />
      </Show>
      <Show when={props.scope.transcript}>
        <SettingsSection title={t("systemHistory.setupTitle")}>
          <p>{t("systemHistory.setupDescription")}</p>
          <Errored
            fallback={(error, reset) => (
              <div role="alert">
                {formatUiError(error())}
                <RetryAction onRetry={reset} />
              </div>
            )}
          >
            <Loading fallback={<SettingsLoadingSkeleton label={t("common.loading")} />}>
              <Show
                when={transcript().turns.length}
                fallback={<p role="status">{t("systemHistory.empty")}</p>}
              >
                <For each={transcript().turns}>
                  {(turn) => (
                    <article class="system-history__change-card">
                      <div class="system-history__change-meta">
                        <strong>
                          {t(
                            turn.role === "user"
                              ? "systemHistory.user"
                              : "systemHistory.setupAssistant",
                          )}
                        </strong>
                        <time datetime={new Date(turn.at).toISOString()}>
                          {new Date(turn.at).toLocaleString()}
                        </time>
                      </div>
                      <p class="system-history__transcript">
                        {turn.text === "<redacted secret>"
                          ? t("systemHistory.redacted")
                          : turn.text}
                      </p>
                    </article>
                  )}
                </For>
              </Show>
            </Loading>
          </Errored>
        </SettingsSection>
      </Show>
    </>
  );
}

export function SystemHistoryPage() {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const scope = createMemo(
    () => {
      const snapshot = gateway.read().snapshot;
      const changes = canCallGatewayMethod(snapshot, "openclaw.changes.list", "operator.admin");
      const transcript = canCallGatewayMethod(snapshot, "openclaw.chat.history", "operator.admin");
      return snapshot.client && (changes || transcript)
        ? {
            client: snapshot.client,
            profile: snapshot.selfUser?.id,
            recoveryScope: snapshot.hello?.auth?.recoveryScope,
            changes,
            transcript,
          }
        : null;
    },
    {
      equals: (a, b) =>
        a === b ||
        Boolean(
          a &&
          b &&
          a.client === b.client &&
          a.profile === b.profile &&
          a.recoveryScope === b.recoveryScope &&
          a.changes === b.changes &&
          a.transcript === b.transcript,
        ),
    },
  );
  return (
    <>
      <SettingsPageHeader
        title={t("systemHistory.title")}
        subtitle={t("systemHistory.description")}
      />
      <SettingsPage>
        {/* Replacing authenticated scope retires all machine-wide read results. */}
        <Show
          when={scope()}
          keyed
          fallback={<p role="status">{t("systemHistory.accessRequired")}</p>}
        >
          {(currentScope) => <HistoryContents scope={currentScope} />}
        </Show>
      </SettingsPage>
    </>
  );
}
