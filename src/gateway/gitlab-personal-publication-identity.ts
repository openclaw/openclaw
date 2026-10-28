import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { GitLabAccount } from "../agents/gitlab-oauth-client.js";
import type { PersonalGitLabCredential } from "./gitlab-personal-oauth.js";

export type GitLabPublicationSource = "personal" | "system-configured" | "agent-override";
export type GitLabPublicationPublisher =
  | { source: "personal" }
  | {
      source: "system-configured" | "agent-override";
      profileId: string;
      recordCreatedAtMs: number;
    };
export type GitLabPublicationCredential = {
  publisher: GitLabPublicationPublisher;
  generation: string;
  account: GitLabAccount;
  assertCurrent: () => void;
  withToken: <T>(run: (token: string) => Promise<T>) => Promise<T>;
  close: () => void;
};

/** The UUID-shaped receipt column follows one immutable managed record across token rotation. */
export function managedGitLabPublicationGeneration(params: {
  publisher: Exclude<GitLabPublicationPublisher, { source: "personal" }>;
  issuer: string;
  accountId: number;
  login: string;
}): string {
  const { publisher } = params;
  const hex = createHash("sha256")
    .update(
      JSON.stringify([
        "managed-gitlab-publication",
        publisher.source,
        publisher.profileId,
        publisher.recordCreatedAtMs,
        params.issuer,
        params.accountId,
        params.login,
      ]),
    )
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function personalGitLabPublicationCredential(
  credential: PersonalGitLabCredential,
): GitLabPublicationCredential {
  return {
    publisher: { source: "personal" },
    generation: credential.generation,
    account: credential.account,
    assertCurrent: credential.assertCurrent,
    withToken: credential.withToken,
    close: () => undefined,
  };
}

/** Absence is the format of accepted personal receipts written before source pinning. */
export function publicationPublisher(
  publisher: GitLabPublicationPublisher | undefined,
): GitLabPublicationPublisher {
  return publisher ?? { source: "personal" };
}

export function sameGitLabPublicationPublisher(
  left: GitLabPublicationPublisher | undefined,
  right: GitLabPublicationPublisher | undefined,
): boolean {
  return isDeepStrictEqual(publicationPublisher(left), publicationPublisher(right));
}
