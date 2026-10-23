// Codex reports plan limits per signed-in account, so each OpenAI account row
// reads its own; the page's forced refresh advances the revision.
import { createMemo, For, Loading, onCleanup, Show } from "solid-js";
import type { UsageSummary } from "../../../../src/infra/provider-usage.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  hasProviderUsageDetails,
  ProviderUsagePanel,
} from "../../components/solid/provider-usage.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";

export type AccountUsageScope = { client: GatewayBrowserClient; agentId: string; revision: number };

export function AccountLimits(props: { scope: AccountUsageScope; profileId: string }) {
  // Page props rebuild the scope object on every update; only its fields mean a new read.
  const request = createMemo(() => ({ ...props.scope, profileId: props.profileId }), {
    equals: (a, b) =>
      a.client === b.client &&
      a.agentId === b.agentId &&
      a.revision === b.revision &&
      a.profileId === b.profileId,
  });
  // A newer read supersedes an older one; Solid drops the stale result.
  const result = createMemo(async () => {
    const { client, agentId, profileId } = request();
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    try {
      const summary = await client.request<UsageSummary>(
        "codex.accountUsage",
        { agentId, profileId },
        { signal: controller.signal, timeoutMs: 30_000 },
      );
      return { providers: summary.providers };
    } catch (error) {
      return { error: formatUiError(error) };
    }
  });
  return (
    <div class="model-providers__account-limits">
      <Loading on={request()} fallback={<span>{t("common.loading")}</span>}>
        <Show when={result().error}>
          {(error) => <span class="provider-usage__error">{error()}</span>}
        </Show>
        <For
          each={result().providers ?? []}
          fallback={
            <Show when={!result().error}>
              <span>{t("modelProviders.noStats")}</span>
            </Show>
          }
        >
          {(snapshot) => (
            <>
              <Show when={snapshot.plan}>
                <strong>{snapshot.plan}</strong>
              </Show>
              <Show
                when={hasProviderUsageDetails(snapshot)}
                fallback={<span>{t("modelProviders.noStats")}</span>}
              >
                <ProviderUsagePanel usage={snapshot} />
              </Show>
            </>
          )}
        </For>
      </Loading>
    </div>
  );
}
