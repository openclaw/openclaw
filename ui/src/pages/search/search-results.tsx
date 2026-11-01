import { For } from "solid-js";
import type { WebSearchTestResult } from "../../../../packages/gateway-protocol/src/schema/web-search.ts";
import {
  SettingsEmpty,
  SettingsRow,
  SettingsSection,
} from "../../components/solid/settings-ui.tsx";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";
import { t } from "../../lib/reactive/i18n.ts";

export function renderSearchTestResult(result: WebSearchTestResult | null, error: string) {
  if (error || result?.status === "error") {
    return (
      <div role="alert" class="callout danger">
        {error || result?.error || t("searchPage.failure")}
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
        <SettingsSection title={t("searchPage.result")}>
          <SettingsRow title={result.content} />
        </SettingsSection>
      ) : undefined}
      {uniqueSources.length ? (
        <SettingsSection title={t("searchPage.sources")} count={uniqueSources.length}>
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
        </SettingsSection>
      ) : !result.content ? (
        <SettingsEmpty message={t("searchPage.noResults")} />
      ) : undefined}
    </>
  );
}
