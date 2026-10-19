import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { UsageSummary } from "../../../../src/infra/provider-usage.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { renderProviderUsageDetails } from "../../components/solid/provider-usage.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";

registerEnglishCatalog(registerSettingsEnglish);

type ModelAccountUsageProps = {
  client: GatewayBrowserClient | null;
  agentId: string;
  profileId: string;
};
type ModelAccountUsageMethods = { refreshUsage: () => void };
export type ModelAccountUsageElement = SolidBridgeElement<
  ModelAccountUsageProps,
  ModelAccountUsageMethods
>;
const usageActions = new WeakMap<
  ModelAccountUsageElement,
  { inputChanged(): void; refresh(): void }
>();

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-model-account-usage": ModelAccountUsageElement;
  }
}

type UsageState =
  | { phase: "idle" | "pending" }
  | { phase: "complete"; summary: UsageSummary }
  | { phase: "error"; error: unknown };

function AccountUsage(props: ModelAccountUsageProps, host: ModelAccountUsageElement) {
  const [state, setState] = createSignal<UsageState>({ phase: "idle" });
  let queued = false;
  const request = createPageRequest(() => {}, {
    task: (
      [client, agentId, profileId]: readonly [GatewayBrowserClient, string, string],
      { signal },
    ) =>
      client.request<UsageSummary>(
        "codex.accountUsage",
        { agentId, profileId },
        { signal, timeoutMs: 30_000 },
      ),
    onComplete: (summary) => {
      setState({ phase: "complete", summary });
    },
    onError: (error) => {
      setState({ phase: "error", error });
    },
  });

  function refresh(): void {
    queued = false;
    const { client, agentId, profileId } = host;
    request.cancel();
    if (!client || !agentId || !profileId) {
      setState({ phase: "idle" });
      return;
    }
    setState({ phase: "pending" });
    void request.run([client, agentId, profileId]);
  }

  onSettled(() => {
    usageActions.set(host, {
      refresh,
      inputChanged() {
        request.cancel();
        if (!queued) {
          queued = true;
          // Native scope properties arrive separately during one render.
          queueMicrotask(() => {
            if (queued) {
              refresh();
            }
          });
        }
      },
    });
    refresh();
    return () => {
      usageActions.delete(host);
      queued = false;
      request.cancel();
    };
  });
  const summary = createMemo(() => {
    const current = state();
    return current.phase === "complete" ? current.summary : undefined;
  });
  const error = createMemo(() => {
    const current = state();
    return current.phase === "error" ? formatUiError(current.error) : undefined;
  });
  return (
    <Show when={props.client}>
      <div class="model-providers__account-usage">
        <button
          class="model-providers__account-refresh"
          type="button"
          aria-label={t("common.refresh")}
          title={t("common.refresh")}
          disabled={state().phase === "pending"}
          onClick={refresh}
        >
          <Icon name="refresh" />
        </button>
        <Show when={state().phase === "pending"}>
          <span>{t("common.loading")}</span>
        </Show>
        <Show when={summary()}>
          {(value) => (
            <For each={value().providers} fallback={<span>{t("modelProviders.noStats")}</span>}>
              {(snapshot) => (
                <>
                  <Show when={snapshot.plan}>
                    <strong>{snapshot.plan}</strong>
                  </Show>
                  <div>
                    <Show
                      when={snapshot.windows.length || snapshot.billing?.length}
                      fallback={t("modelProviders.noStats")}
                    >
                      {renderProviderUsageDetails(snapshot, { groupWindows: true })}
                    </Show>
                  </div>
                </>
              )}
            </For>
          )}
        </Show>
        <Show when={error()}>
          <span class="provider-usage-error">{error()}</span>
        </Show>
      </div>
    </Show>
  );
}

defineSolidBridge<ModelAccountUsageProps, ModelAccountUsageMethods>(
  "openclaw-model-account-usage",
  (props, host) => AccountUsage(props, host),
  {
    propertyChanged: (host) => usageActions.get(host)?.inputChanged(),
    properties: {
      client: { default: null, attribute: false },
      agentId: { default: "" },
      profileId: { default: "" },
    },
    methods: {
      refreshUsage: (host) => usageActions.get(host)?.refresh(),
    },
  },
);
