import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeRawCredentialEntry } from "../../agents/auth-profiles/persisted-credential.js";
import { updateAuthProfileStoreWithLock } from "../../agents/auth-profiles/store-runtime.js";
import type { ProviderAuthProfile } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { WizardCancelledError, type WizardPrompter } from "../../wizard/prompts.js";

/** Naming is best effort; the completed sign-in is never rolled back for it. */
export async function offerSavedAuthProfileName(params: {
  profile: ProviderAuthProfile;
  providerLabel: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  agentDir: string;
  stateDir?: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): Promise<void> {
  const { prompter, providerLabel, profile, runtime } = params;
  if (!prompter.optionalText || params.signal?.aborted) {
    return;
  }
  const { profileId, credential } = profile;
  const existingLabel =
    normalizeOptionalString(credential.displayName) ?? normalizeOptionalString(credential.email);
  const initialValue = existingLabel ?? providerLabel;
  const warn = () =>
    runtime.error("The account is connected, but its custom name could not be saved.");
  try {
    const displayName = normalizeOptionalString(
      await prompter.optionalText({
        message: `Name this ${providerLabel} account (optional)`,
        initialValue,
        placeholder: "e.g. Personal or Work",
        signal: params.signal,
      }),
    );
    if (!displayName || displayName === existingLabel || params.signal?.aborted) {
      return;
    }
    // Do not resurrect a removed profile or write a name onto a replacement sign-in.
    const saved = normalizeRawCredentialEntry(credential);
    const updated = await updateAuthProfileStoreWithLock({
      agentDir: params.agentDir,
      profileId,
      stateDir: params.stateDir,
      sharedStoreWrite: true,
      assertCurrent: params.assertCurrent,
      saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
      updater(store) {
        const current = store.profiles[profileId];
        if (!current || !isDeepStrictEqual(current, saved)) {
          return false;
        }
        store.profiles[profileId] = { ...current, displayName };
        return true;
      },
    });
    if (updated?.profiles[profileId]?.displayName !== displayName) {
      warn();
    }
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      runtime.log("The account is connected without a custom name.");
    } else if (!params.signal?.aborted) {
      warn();
    }
  }
}
