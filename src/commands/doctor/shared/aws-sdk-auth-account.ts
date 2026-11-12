// Doctor creation of the stored account behind a configured AWS SDK provider route.
import {
  buildAwsSdkAuthProfileCredential,
  isAwsSdkAuthProfileCredential,
  resolveAwsSdkAuthProfileId,
} from "../../../agents/auth-profiles/aws-sdk-account.js";
import { isStoredCredentialCompatibleWithAuthProvider } from "../../../agents/auth-profiles/order.js";
import { resolveSharedMainAuthAgentDir } from "../../../agents/auth-profiles/shared-main-dir.js";
import {
  loadAuthProfileStoreWithoutExternalProfilesAsync,
  updateAuthProfileStoreWithLock,
} from "../../../agents/auth-profiles/store-runtime.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";

/** Providers whose config routes inference through the AWS SDK default chain. */
function listConfiguredAwsSdkProviders(cfg: OpenClawConfig): string[] {
  return Object.entries(cfg.models?.providers ?? {})
    .filter(([, provider]) => provider?.auth === "aws-sdk")
    .map(([providerId]) => providerId)
    .toSorted();
}

/**
 * Give every configured AWS SDK route the stored account that owns it.
 *
 * The route itself holds no credential, so before this record existed a
 * scheduled run had no account to bind and stayed refused. The record is a
 * marker only; an occupied id is never replaced, because overwriting it would
 * silently retire whichever account already owns that name.
 */
export async function maybeCreateAwsSdkAuthProfileAccounts(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const env = params.env ?? process.env;
  const providers = listConfiguredAwsSdkProviders(params.cfg);
  if (providers.length === 0) {
    return { changes: [], warnings: [] };
  }
  const changes: string[] = [];
  const warnings: string[] = [];
  // The account is a shared credential, so it belongs to the shared store's own owner.
  // Deriving it from a default agent would refuse every explicit multi-agent fleet, and
  // each agent's store inherits this record anyway.
  const agentDir = resolveSharedMainAuthAgentDir(env);
  const store = await loadAuthProfileStoreWithoutExternalProfilesAsync(agentDir);
  for (const provider of providers) {
    const profileId = resolveAwsSdkAuthProfileId(provider);
    const existing = store.profiles[profileId];
    if (existing) {
      if (
        isAwsSdkAuthProfileCredential(existing) &&
        isStoredCredentialCompatibleWithAuthProvider({
          cfg: params.cfg,
          provider,
          credential: existing,
        })
      ) {
        continue;
      }
      warnings.push(
        `Auth profile ${profileId} already holds a ${existing.type} credential for ${existing.provider}, so the ${provider} AWS SDK account was left uncreated. Sign that account out or rename it, then rerun ${formatCliCommand("openclaw doctor --fix")}.`,
      );
      continue;
    }
    if (!params.shouldRepair) {
      warnings.push(
        `Provider ${provider} routes through the AWS SDK credential chain but has no ${profileId} account, so scheduled runs cannot record which account they used. Run ${formatCliCommand("openclaw doctor --fix")} to create it.`,
      );
      continue;
    }
    let created = false;
    try {
      // Recheck under the lock: only an absent id may be claimed.
      const updated = await updateAuthProfileStoreWithLock({
        agentDir,
        profileId,
        sharedStoreWrite: true,
        saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
        updater(locked) {
          if (locked.profiles[profileId]) {
            return false;
          }
          locked.profiles[profileId] = buildAwsSdkAuthProfileCredential(provider);
          created = true;
          return true;
        },
      });
      if (!updated) {
        throw new Error("its auth profile writer was unavailable.");
      }
    } catch (error) {
      warnings.push(
        `Could not create auth profile ${profileId} for the ${provider} AWS SDK credential chain: ${formatErrorMessage(error)} Rerun ${formatCliCommand("openclaw doctor --fix")}.`,
      );
    }
    if (created) {
      changes.push(
        `Created auth profile ${profileId} for the ${provider} AWS SDK credential chain; it stores no AWS credentials.`,
      );
    }
  }
  return { changes, warnings };
}
