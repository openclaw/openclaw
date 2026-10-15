import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { UsageSummary } from "../../../../src/infra/provider-usage.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { renderProviderUsageDetails } from "../../components/solid/provider-usage.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";

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
  let request: AbortController | undefined;

  async function load(scope: ModelAccountUsageProps): Promise<void> {
    request?.abort();
    request = undefined;
    if (!scope.client || !scope.agentId || !scope.profileId) {
      setState({ phase: "idle" });
      return;
    }
    const current = new AbortController();
    request = current;
    const isCurrent = () =>
      request === current &&
      props.client === scope.client &&
      props.agentId === scope.agentId &&
      props.profileId === scope.profileId;
    setState({ phase: "pending" });
    try {
      const summary = await scope.client.request<UsageSummary>(
        "codex.accountUsage",
        { agentId: scope.agentId, profileId: scope.profileId },
        { signal: current.signal, timeoutMs: 30_000 },
      );
      if (isCurrent()) {
        setState({ phase: "complete", summary });
      }
    } catch (error) {
      if (isCurrent()) {
        setState({ phase: "error", error });
      }
    }
  }

  const scope = () => ({
    client: props.client,
    agentId: props.agentId,
    profileId: props.profileId,
  });
  const refresh = () => void load(scope());
  createEffect(scope, (current) => void load(current));
  host.addEventListener("model-account-usage-refresh", refresh);
  onCleanup(() => {
    host.removeEventListener("model-account-usage-refresh", refresh);
    request?.abort();
    request = undefined;
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
    properties: {
      client: { default: null, attribute: false },
      agentId: { default: "" },
      profileId: { default: "" },
    },
    methods: {
      refreshUsage: (host) => {
        host.dispatchEvent(new Event("model-account-usage-refresh"));
      },
    },
  },
);
