import { prepareGitCoauthorAttribution } from "../agents/git-coauthor-attribution.js";
import { appendPrAttribution, preparePrAttribution } from "../agents/pr-attribution.js";
import { resolveControlUiPublicSessionUrl } from "../config/control-ui-link-base.js";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { RepositoryPublicationFailureError } from "./github-publication-errors.js";
import {
  RepositoryPublicationCreditChangedError,
  type RepositoryPublicationContentHostV1,
  type RepositoryPublicationContentFactsV1,
} from "./repository-publication-content-contract.js";
import type { RepositoryPublicationProvider } from "./repository-publication-contract.js";
import { hasGitHubPublicationMessageFooter } from "./repository-publication-message.js";

/** Reuse the accepted owner's retained read; formatting never selects session storage. */
export async function prepareRepositoryPublicationContentFacts(params: {
  session: { agentId: string; sessionKey: string; sessionId: string };
  requesterProfileId?: string;
  storePath: string;
  config: OpenClawConfig;
  accountId: number;
  host: string;
  readCurrentEntry: () => InternalSessionEntry | undefined;
  assertCurrent: () => void;
}): Promise<RepositoryPublicationContentFactsV1> {
  const initialEntry = params.readCurrentEntry();
  const initialShare = resolveSessionPublicShare(initialEntry);
  const sessionUrl = resolveControlUiPublicSessionUrl(params.config, {
    ...params.session,
    entry: initialEntry,
  });
  const prepared = await prepareGitCoauthorAttribution({
    ...params.session,
    config: params.config,
    excludeAccountId: params.accountId,
    host: params.host,
    storePath: params.storePath,
  });
  const attributionEnabled = await preparePrAttribution({
    requesterProfileId: params.requesterProfileId,
    sessionKey: params.session.sessionKey,
    incognito: initialEntry?.incognito,
  });
  params.assertCurrent();
  return {
    appendAttribution(body) {
      return appendPrAttribution(
        body,
        attributionEnabled() && !params.readCurrentEntry()?.incognito,
      );
    },
    credit: {
      trailers: prepared.attribution?.trailers ?? [],
      logins: prepared.attribution?.logins ?? [],
    },
    assertCurrent() {
      params.assertCurrent();
      if (!prepared.isCurrent()) {
        throw new RepositoryPublicationCreditChangedError();
      }
    },
    currentSessionUrl() {
      const currentShare = resolveSessionPublicShare(params.readCurrentEntry());
      return sessionUrl &&
        currentShare?.id === initialShare?.id &&
        currentShare?.sessionId === initialShare?.sessionId
        ? sessionUrl
        : undefined;
    },
  };
}

/** Adapt the current native receipt without moving attribution or sharing custody. */
export function createRepositoryPublicationContentHostV1(
  params: Omit<Parameters<typeof prepareRepositoryPublicationContentFacts>[0], "host"> & {
    baseRemoteUrl: string;
  },
): RepositoryPublicationContentHostV1 {
  return {
    prepare: () =>
      prepareRepositoryPublicationContentFacts({
        ...params,
        host: new URL(params.baseRemoteUrl).hostname,
      }),
  };
}

/** Prepare workspace publication text and validate any earlier request-owned credit. */
export async function prepareWorkspacePublicationContent(
  provider: Pick<RepositoryPublicationProvider, "formatContent">,
  params: Omit<
    Parameters<typeof createRepositoryPublicationContentHostV1>[0],
    "session" | "accountId" | "baseRemoteUrl"
  > &
    Pick<
      Parameters<RepositoryPublicationProvider["formatContent"]>[0],
      "request" | "target" | "publisher"
    > & {
      preparedMessage?: string;
      marker: string;
    },
) {
  const content = await provider.formatContent({
    request: params.request,
    target: params.target,
    publisher: params.publisher,
    host: createRepositoryPublicationContentHostV1({
      session: params.request.session,
      baseRemoteUrl: params.target.baseRemoteUrl,
      accountId: params.request.publisher.account.accountId,
      requesterProfileId: params.requesterProfileId,
      storePath: params.storePath,
      readCurrentEntry: params.readCurrentEntry,
      assertCurrent: params.assertCurrent,
      config: params.config,
    }),
    description:
      params.request.body?.trim() ||
      "Published by the Gateway after authoritative workspace reconciliation.",
  });
  content.assertCurrent();
  if (
    params.preparedMessage !== undefined &&
    !hasGitHubPublicationMessageFooter(params.preparedMessage, content.trailers, params.marker)
  ) {
    throw new RepositoryPublicationFailureError("Publication contributor credit changed.", {
      code: "identity_changed",
      nextAction:
        "Review contributor credit and reconcile recorded publication effects before requesting publication again.",
    });
  }
  return content;
}
