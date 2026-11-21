// Codex reports plan limits per signed-in account, so each OpenAI account row
// reads its own; the page's forced refresh advances the revision.
import { createMemo, Loading, onCleanup, Show } from "solid-js";
import type {
  ProviderUsageSnapshot,
  UsageSummary,
} from "../../../../src/infra/provider-usage.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  hasProviderUsageDetails,
  ProviderUsagePanel,
} from "../../components/solid/provider-usage.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";

// The Codex account-details contract reports a numeric balance independently of quota windows.
export function accountCreditBalance(snapshot?: ProviderUsageSnapshot) {
  const balance = snapshot?.billing?.find(
    (entry) => entry.type === "balance" && entry.unit === "credits" && !entry.label,
  );
  return balance?.type === "balance" ? balance : undefined;
}

export type AccountUsageScope = { client: GatewayBrowserClient; agentId: string; revision: number };

function AccountReading(props: { snapshot: ProviderUsageSnapshot; grouped?: boolean }) {
  const balance = createMemo(() =>
    props.grouped ? accountCreditBalance(props.snapshot) : undefined,
  );
  const details = createMemo(() => ({
    windows: props.snapshot.windows.filter((window) => window.groupLabel),
    billing: props.snapshot.billing?.filter((entry) => entry !== balance()),
    costHistory: props.snapshot.costHistory,
  }));
  const primary = createMemo(() => ({
    windows: props.grouped ? [] : props.snapshot.windows.filter((window) => !window.groupLabel),
    // The comparison already reports failed and partial readings beside the affected account.
    error: props.grouped ? undefined : props.snapshot.error,
    summary: props.snapshot.summary,
  }));
  return (
    <>
      <Show when={hasProviderUsageDetails(primary())}>
        <ProviderUsagePanel compact usage={primary()} />
      </Show>
      <Show when={props.snapshot.plan && (props.grouped || !hasProviderUsageDetails(details()))}>
        <span class="model-providers__account-plan">{props.snapshot.plan}</span>
      </Show>
      <Show when={hasProviderUsageDetails(details())}>
        <Show
          when={props.grouped}
          fallback={
            <details class="model-providers__account-details">
              <summary>
                {t("modelProviders.limits.accountDetails")}
                {props.snapshot.plan ? ` · ${props.snapshot.plan}` : ""}
              </summary>
              <ProviderUsagePanel compact usage={details()} />
            </details>
          }
        >
          <ProviderUsagePanel compact usage={details()} />
        </Show>
      </Show>
      <Show when={!props.snapshot.plan && !hasProviderUsageDetails(props.snapshot)}>
        <span>{t("modelProviders.noStats")}</span>
      </Show>
    </>
  );
}

type AccountKey = Pick<AccountUsageScope, "client" | "agentId"> & { profileId: string };
type Reading = {
  account: AccountKey;
  loading?: true;
  snapshot?: ProviderUsageSnapshot;
  error?: string;
};

// A keyed profile owns one read, regardless of how many quota windows it appears in.
export function createAccountUsage(scope: () => AccountUsageScope, profileId: () => string) {
  const account = createMemo(
    () => ({ client: scope().client, agentId: scope().agentId, profileId: profileId() }),
    {
      equals: (a, b) =>
        a.client === b.client && a.agentId === b.agentId && a.profileId === b.profileId,
    },
  );
  const revision = createMemo(() => scope().revision);
  const result = createMemo<Reading>((previous) => {
    const key = account();
    revision();
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    // A slow login must not hold the other segments. A refresh retains only this login's reading.
    const response = key.client
      .request<UsageSummary>(
        "codex.accountUsage",
        { agentId: key.agentId, profileId: key.profileId },
        { signal: controller.signal, timeoutMs: 30_000 },
      )
      .then(
        (summary): Reading => ({ account: key, snapshot: summary.providers[0] }),
        (error: unknown): Reading => ({ account: key, error: formatUiError(error) }),
      );
    return (async function* () {
      yield previous?.account === key ? previous : { account: key, loading: true as const };
      yield await response;
    })();
  });
  return { account, result };
}
export type AccountUsageRead = ReturnType<typeof createAccountUsage>;

export function AccountLimits(props: { read: AccountUsageRead; grouped?: boolean }) {
  const result = () => props.read.result();
  return (
    <div class="model-providers__account-limits">
      <Loading
        on={props.read.account()}
        fallback={props.grouped ? undefined : <span>{t("common.loading")}</span>}
      >
        <Show
          when={result().snapshot}
          fallback={
            <Show when={!props.grouped || (!result().loading && result().error === undefined)}>
              <span class={result().error ? "provider-usage__error" : undefined}>
                {result().error ||
                  t(result().loading ? "common.loading" : "modelProviders.noStats")}
              </span>
            </Show>
          }
        >
          {(snapshot) => <AccountReading snapshot={snapshot()} grouped={props.grouped} />}
        </Show>
      </Loading>
    </div>
  );
}
