import { readRuntimeConfig } from "../config/runtime-snapshot.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { prepareRepositoryPublicationContentFacts } from "./github-publication-content.js";
import type { PublicationSessionIdentity } from "./github-publication-session.types.js";

/** Host identity proof retains contributor selection and revocation without preparing publisher credentials. */
export function prepareGitHubPublicationContentFacts(params: {
  session: PublicationSessionIdentity;
  storePath: string;
  accountId: number;
  host: string;
  assertCurrent: () => void;
  readCurrentEntry: () => InternalSessionEntry | undefined;
}) {
  return prepareRepositoryPublicationContentFacts({ ...params, config: readRuntimeConfig() });
}
