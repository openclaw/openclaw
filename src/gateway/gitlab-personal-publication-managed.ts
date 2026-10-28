import { isDeepStrictEqual } from "node:util";
import { inspectGitLabManagedOAuthRecord } from "../agents/gitlab-managed-records.js";
import { prepareGitLabToolCredential } from "../agents/gitlab-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  managedGitLabPublicationGeneration,
  type GitLabPublicationCredential,
} from "./gitlab-personal-publication-identity.js";

/** This path never consults a person's GitLab grant or ambient CLI login. */
export async function prepareManagedGitLabPublicationCredential(params: {
  config: OpenClawConfig;
  getCurrentConfig: () => OpenClawConfig;
  agentId: string;
  assertCurrent: () => void;
}): Promise<GitLabPublicationCredential> {
  const oauthConfig = params.config.gateway?.gitlab;
  if (!oauthConfig) {
    throw new Error("Managed GitLab publication is unavailable.");
  }
  const prepared = await prepareGitLabToolCredential({
    config: params.config,
    getCurrentConfig: params.getCurrentConfig,
    agentId: params.agentId,
    oauthConfig,
    assertCurrent: params.assertCurrent,
    assertCurrentSync: params.assertCurrent,
  });
  try {
    const inspected = await inspectGitLabManagedOAuthRecord(prepared.profileId);
    prepared.assertCurrentSync();
    if (
      inspected.state !== "valid" ||
      inspected.record.profileId !== prepared.profileId ||
      inspected.record.issuer !== prepared.issuer ||
      !isDeepStrictEqual(inspected.record.account, prepared.account) ||
      inspected.record.pendingInitial ||
      inspected.record.refreshClaim ||
      inspected.record.refreshFailure
    ) {
      throw new Error("Managed GitLab publication identity changed.");
    }
    const publisher = {
      source: prepared.source,
      profileId: prepared.profileId,
      recordCreatedAtMs: inspected.record.createdAtMs,
    } as const;
    const generation = managedGitLabPublicationGeneration({
      publisher,
      issuer: prepared.issuer,
      accountId: prepared.account.accountId,
      login: prepared.account.login,
    });
    prepared.assertCurrentSync();
    return {
      publisher,
      generation,
      account: prepared.account,
      assertCurrent: prepared.assertCurrentSync,
      withToken: prepared.withToken,
      close: prepared.close,
    };
  } catch (error) {
    prepared.close();
    throw error;
  }
}
