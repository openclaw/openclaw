import { For, Show } from "solid-js";
import type {
  WebSearchStatusResult,
  WebSearchTestResult,
} from "../../../../packages/gateway-protocol/src/schema/web-search.ts";
import { SettingsEmpty, SettingsRow, SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";
import { t } from "../../lib/reactive/i18n.ts";

export function SearchTestStatus(props: {
  pending?: boolean;
  failed?: boolean;
  result: WebSearchTestResult | null | undefined;
  providers: WebSearchStatusResult["providers"];
}) {
  const last = () => (props.pending || props.failed ? null : props.result);
  const failed = () => !props.pending && (props.failed || last()?.status === "error");
  const detail = () => {
    const response = last();
    return response
      ? `${props.providers.find((provider) => provider.id === response.provider)?.label ?? response.provider} · ${t("searchPage.duration", { ms: String(response.latencyMs) })}${response.cached ? ` · ${t("searchPage.cached")}` : ""}`
      : undefined;
  };
  return (
    <div class="search-test__status">
      <span role="status">
        <SettingsStatus
          kind={failed() ? "danger" : last() ? "ok" : "muted"}
          label={t(
            `searchPage.${props.pending ? "testing" : failed() ? "failure" : last() ? "success" : "untested"}`,
          )}
        />
      </span>
      <Show when={detail()}>{(text) => <span class="search-test__detail">{text()}</span>}</Show>
    </div>
  );
}

export function renderSearchTestResult(result: WebSearchTestResult | null, error: string) {
  if (error || result?.status === "error") {
    return (
      <div class="search-test__failure">
        <div role="alert" class="callout danger">
          {error || result?.error || t("searchPage.failure")}
        </div>
      </div>
    );
  }
  if (!result) {
    return undefined;
  }
  const sources: Array<{ url: string; title?: string; snippet?: string }> = [
    ...(result.results ?? []),
    ...(result.citations ?? []),
  ];
  const uniqueSources = sources.filter(
    (source, index) => sources.findIndex((item) => item.url === source.url) === index,
  );
  return (
    <>
      {result.content ? (
        <SettingsRow title={t("searchPage.result")} description={result.content} stacked />
      ) : undefined}
      {uniqueSources.length ? (
        <>
          <div class="search-test__label">{t("searchPage.sources")}</div>
          <For each={uniqueSources} keyed={(source) => source.url}>
            {(source) => {
              const url = () => {
                const safe = resolveSafeExternalUrl(source().url, window.location.href);
                return safe && /^https?:/u.test(safe) ? safe : undefined;
              };
              return (
                <SettingsRow
                  title={
                    url() ? (
                      <a href={url()} target="_blank" rel="noopener noreferrer">
                        {source().title || source().url}
                      </a>
                    ) : (
                      source().title || source().url
                    )
                  }
                  description={(() => {
                    const entry = source();
                    return "snippet" in entry ? entry.snippet : entry.url;
                  })()}
                />
              );
            }}
          </For>
        </>
      ) : !result.content ? (
        <SettingsEmpty message={t("searchPage.noResults")} />
      ) : undefined}
    </>
  );
}
