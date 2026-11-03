import { readNativeGitHubToken } from "../agents/github-read-identity.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import type { RepositoryPublicationPublisher } from "./repository-publication-contract.js";
import { performRepositoryPublicationGit } from "./repository-publication-git-transfer.js";

const publishers = new WeakMap<
  RepositoryPublicationPublisher,
  () => PreparedGitHubPublicationIdentity
>();
/** The plugin retains credentials and the live selected account; the host receives provenance only. */
export async function prepareGitHubPublisher(
  _agentId: string,
  expected:
    | import("./repository-publication-contract.js").NativeGitHubPublisherProvenance
    | undefined,
  owner: {
    prepare(): Promise<PreparedGitHubPublicationIdentity>;
    isCurrent(identity: PreparedGitHubPublicationIdentity): boolean;
  },
): Promise<RepositoryPublicationPublisher> {
  let identity = await owner.prepare();
  const selected = expected ?? identity;
  const provenance = {
    source: selected.source,
    ...(selected.profileId ? { profileId: selected.profileId } : {}),
    account: selected.account,
  };
  if (!sameGitHubPublisherSelection(identity, selected)) {
    throw new Error("GitHub publication identity changed.");
  }
  const assertCurrent = () => {
    if (!owner.isCurrent(identity)) {
      throw new Error("GitHub publication identity changed.");
    }
  };
  const publisher: RepositoryPublicationPublisher = {
    provenance,
    author: {
      name: identity.account.login,
      email: `${identity.account.accountId}+${identity.account.login}@users.noreply.github.com`,
    },
    assertCurrent,
    async refresh() {
      assertCurrent();
      const next = await owner.prepare();
      assertCurrent();
      if (!sameGitHubPublisherSelection(next, selected)) {
        throw new Error("GitHub publication identity changed.");
      }
      identity = next;
      assertCurrent();
    },
    async authorizeGit(transfer) {
      assertCurrent();
      const token = await readNativeGitHubToken(identity.env, true, identity.host);
      assertCurrent();
      if (!token) {
        throw new Error("GitHub publication credential is unavailable.");
      }
      await performRepositoryPublicationGit(transfer, {
        httpAuthorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        assertCurrent,
      });
    },
  };
  assertCurrent();
  publishers.set(publisher, () => {
    assertCurrent();
    return identity;
  });
  return publisher;
}
/** Only this plugin's publisher leases can reach its GitHub transport. */
export function readGitHubPublisher(
  publisher: RepositoryPublicationPublisher,
): PreparedGitHubPublicationIdentity {
  const read = publishers.get(publisher);
  if (!read) {
    throw new Error("GitHub publication publisher is unavailable.");
  }
  return read();
}

/** Login casing is presentation; source, profile and verified account select the identity. */
export function sameGitHubPublisherSelection(
  actual: import("./repository-publication-contract.js").NativeGitHubPublisherProvenance,
  expected: import("./repository-publication-contract.js").NativeGitHubPublisherProvenance,
): boolean {
  return (
    actual.source === expected.source &&
    actual.profileId === expected.profileId &&
    actual.account.accountId === expected.account.accountId &&
    actual.account.login.toLowerCase() === expected.account.login.toLowerCase()
  );
}
