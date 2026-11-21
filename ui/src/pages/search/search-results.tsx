import type { WebSearchTestResult } from "../../../../packages/gateway-protocol/src/schema/web-search.ts";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";

export type SearchTestOutcomeProps = {
  pending?: boolean;
  result?: WebSearchTestResult | null;
  error?: string;
  /** What this route tests, shown until a result names the provider that answered. */
  route: string;
  providerLabel: (id: string) => string;
};

function outcome(
  pending: boolean | undefined,
  error: string | undefined,
  result: WebSearchTestResult | null | undefined,
) {
  const last = pending || error ? null : (result ?? null);
  const failed = !pending && Boolean(error || last?.status === "error");
  return { last, failed };
}

/** The test's state, in the place a row title takes. */
export function SearchTestStatus(props: SearchTestOutcomeProps) {
  const state = () => outcome(props.pending, props.error, props.result);
  return (
    <span role="status" class="search-test-status">
      <SettingsStatus
        kind={state().failed ? "danger" : state().last ? "ok" : "muted"}
        label={t(
          `searchPage.${props.pending ? "testing" : state().failed ? "failure" : state().last ? "success" : "untested"}`,
        )}
      />
    </span>
  );
}

/**
 * One line under the state. Settings proves that search answered, through which provider and how
 * fast; the pages it returned belong in chat, not here.
 */
export function SearchTestDetail(props: SearchTestOutcomeProps) {
  const text = () => {
    const { last, failed } = outcome(props.pending, props.error, props.result);
    if (failed) {
      return props.error || last?.error || t("searchPage.failure");
    }
    if (!last) {
      return props.route;
    }
    if (!last.content && !last.results?.length && !last.citations?.length) {
      return t("searchPage.noResults");
    }
    return [
      props.providerLabel(last.provider),
      t("searchPage.duration", { ms: String(last.latencyMs) }),
      ...(last.cached ? [t("searchPage.cached")] : []),
    ].join(" · ");
  };
  return <>{text()}</>;
}
