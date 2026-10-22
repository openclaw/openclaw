import { createMemo, createSignal, Errored, For, Loading, onSettled, Show } from "solid-js";
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

function AccountUsage(props: ModelAccountUsageProps, host: ModelAccountUsageElement) {
  const [receipt, setReceipt] = createSignal(
    { promise: Promise.resolve<UsageSummary | null>(null) },
    { equals: false },
  );
  let pending: ReturnType<typeof Promise.withResolvers<UsageSummary | null>> | undefined;
  let queued = false;
  const request = createPageRequest(() => setReceipt((current) => current), {
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
      pending?.resolve(summary);
      pending = undefined;
    },
    onError: (error) => {
      pending?.reject(error);
      pending = undefined;
    },
  });
  const refreshing = createMemo(() => {
    // Receipt notifications also project the owner's pending state for the stable control.
    receipt();
    return request.pending;
  });

  function retire(): void {
    request.cancel();
    // An aborted transport may never settle; release its presentation read now.
    pending?.resolve(null);
    pending = undefined;
  }

  function refresh(): void {
    queued = false;
    const { client, agentId, profileId } = host;
    retire();
    if (!client || !agentId || !profileId) {
      setReceipt({ promise: Promise.resolve(null) });
      return;
    }
    pending = Promise.withResolvers<UsageSummary | null>();
    // Native refresh can replace a rejected receipt before Solid observes it.
    void pending.promise.catch(() => {});
    setReceipt({ promise: pending.promise });
    void request.run([client, agentId, profileId]);
  }

  onSettled(() => {
    usageActions.set(host, {
      refresh,
      inputChanged() {
        retire();
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
      retire();
    };
  });
  return (
    <Show when={props.client}>
      <div class="model-providers__account-usage">
        <button
          class="model-providers__account-refresh"
          type="button"
          aria-label={t("common.refresh")}
          title={t("common.refresh")}
          disabled={refreshing()}
          onClick={refresh}
        >
          <Icon name="refresh" />
        </button>
        {/* Refresh replaces the stateless snapshot and retires its previous error boundary. */}
        <Show when={receipt()} keyed>
          {(current) => (
            <Errored
              fallback={(error) => (
                <span class="provider-usage-error">{formatUiError(error())}</span>
              )}
            >
              <Loading fallback={<span>{t("common.loading")}</span>}>
                <UsageDetails receipt={current.promise} />
              </Loading>
            </Errored>
          )}
        </Show>
      </div>
    </Show>
  );
}

function UsageDetails(props: { receipt: Promise<UsageSummary | null> }) {
  const usage = createMemo(() => props.receipt);
  return (
    <>
      <Show when={usage()}>
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
    </>
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
