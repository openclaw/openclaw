import { html, nothing } from "lit";
import type { WebSearchTestResult } from "../../../../packages/gateway-protocol/src/schema/web-search.ts";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";

export function renderSearchTestResult(result: WebSearchTestResult | null, error: string) {
  if (error || result?.status === "error") {
    return html`<div role="alert" class="callout danger">
      ${error || result?.error || t("searchPage.failure")}
    </div>`;
  }
  if (!result) {
    return nothing;
  }
  const sources = [...(result.results ?? []), ...(result.citations ?? [])];
  const uniqueSources = sources.filter(
    (source, index) => sources.findIndex((item) => item.url === source.url) === index,
  );
  return html`
    ${result.content ? renderSettingsSection({ title: t("searchPage.result") }, renderSettingsRow({ title: result.content })) : nothing}
    ${
      uniqueSources.length
        ? renderSettingsSection(
            { title: t("searchPage.sources"), count: uniqueSources.length },
            uniqueSources.map((source) => {
              const safeUrl = resolveSafeExternalUrl(source.url, window.location.href);
              const url = safeUrl && /^https?:/u.test(safeUrl) ? safeUrl : null;
              return renderSettingsRow({
                title: url
                  ? html`<a href=${url} target="_blank" rel="noopener noreferrer"
                      >${source.title || source.url}</a
                    >`
                  : source.title || source.url,
                description: "snippet" in source ? source.snippet : source.url,
              });
            }),
          )
        : !result.content
          ? renderSettingsEmpty(t("searchPage.noResults"))
          : nothing
    }
  `;
}
