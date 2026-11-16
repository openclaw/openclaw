import type { ControlUiRepositorySearchResult } from "../../../../packages/gateway-protocol/src/plugin-control-ui-repositories.js";
import type { RemoteProject } from "../../../../packages/gateway-protocol/src/schema/projects.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import { isControlUiRepositorySearchResult } from "../../lib/protocol-validators.generated/session-input.js";
import type { ControlUiRepositorySourceContribution } from "../../plugins/control-ui-metadata.ts";

registerNewSessionSetupEnglish();

export type RepositorySourceSearchGroup = {
  source: ControlUiRepositorySourceContribution;
  items: RemoteProject[];
  notice?: string;
  loading: boolean;
  error: string | null;
};

/** One query generation owns every source request; individual sources settle independently. */
export class RepositorySourceSearch {
  private requests: (() => void)[] = [];
  groups: readonly RepositorySourceSearchGroup[] = [];

  constructor(private readonly changed: () => void) {}

  search(
    client: GatewayBrowserClient | null,
    sources: readonly ControlUiRepositorySourceContribution[],
    query: string,
  ) {
    this.cancel();
    if (!client || query.length < 2) {
      return;
    }
    const groups = sources.map((source): RepositorySourceSearchGroup => ({
      source,
      items: [],
      loading: true,
      error: null,
    }));
    this.groups = groups;
    for (const group of groups) {
      const request = createPageRequest(this.changed, {
        task: async (_: undefined, { signal }) => {
          const result = await client.request(group.source.searchMethod, { query }, { signal });
          if (!isControlUiRepositorySearchResult(result)) {
            throw new Error("The repository source returned an invalid search result.");
          }
          return result;
        },
        onComplete: (result: ControlUiRepositorySearchResult) => {
          this.groups = this.groups.map((current) =>
            current === group
              ? Object.assign({}, current, {
                  items: result.projects,
                  notice:
                    result.credential === "missing"
                      ? t("newSession.remoteCredentialHint", { source: group.source.label })
                      : undefined,
                  loading: false,
                })
              : current,
          );
        },
        onError: (error) => {
          this.groups = this.groups.map((current) =>
            current === group
              ? Object.assign({}, current, { error: formatUiError(error), loading: false })
              : current,
          );
        },
      });
      this.requests.push(request.cancel);
      void request.run(undefined);
    }
  }

  cancel() {
    for (const stop of this.requests) {
      stop();
    }
    this.requests = [];
    this.groups = [];
  }
}
