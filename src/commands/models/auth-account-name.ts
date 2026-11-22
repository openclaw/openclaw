import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeRawCredentialEntry } from "../../agents/auth-profiles/persisted-credential.js";
import { updateAuthProfileStoreWithLock } from "../../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderAuthMethod, ProviderAuthProfile } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { WizardCancelledError, type WizardPrompter } from "../../wizard/prompts.js";
import { isAuthProfileReconnect } from "./auth-relogin-identity.js";

/** Keep a saved name only for a proven reconnect; offer a name after a new credential is saved. */
export function planAuthProfileNames(
  { profiles }: { profiles: ProviderAuthProfile[] },
  { profiles: stored }: { profiles: Readonly<Record<string, AuthProfileCredential>> },
  login: {
    method: ProviderAuthMethod;
    existingProfiles?: Readonly<Record<string, AuthProfileCredential>>;
    provider: { label: string };
    config: OpenClawConfig;
    prompter: WizardPrompter;
    runtime: RuntimeEnv;
    agentDir: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    assertCurrent?: () => void;
  },
) {
  const reconnects = new Set<string>();
  return {
    profiles: profiles.map((profile) => {
      const { profileId, credential } = profile;
      const previous = stored[profileId] ?? login.existingProfiles?.[profileId];
      if (!isAuthProfileReconnect(credential, previous, login.method)) {
        return profile;
      }
      reconnects.add(profileId);
      return previous.displayName
        ? { ...profile, credential: { ...credential, displayName: previous.displayName } }
        : profile;
    }),
    offerName: async (persisted: ProviderAuthProfile[]) => {
      const [saved] = persisted;
      if (
        !login.prompter.optionalText ||
        !saved ||
        persisted.length !== 1 ||
        reconnects.has(saved.profileId) ||
        normalizeOptionalString(login.config.auth?.profiles?.[saved.profileId]?.displayName) ||
        !Object.entries(stored).some(
          ([id, credential]) =>
            id !== saved.profileId && credential.provider === saved.credential.provider,
        )
      ) {
        return;
      }
      await offerSavedAuthProfileName({
        profile: saved,
        providerLabel: login.provider.label,
        prompter: login.prompter,
        runtime: login.runtime,
        agentDir: login.agentDir,
        stateDir: (login.env ?? process.env).OPENCLAW_STATE_DIR,
        signal: login.signal,
        assertCurrent: login.assertCurrent,
      });
    },
  };
}

/** Naming is best effort; the completed sign-in is never rolled back for it. */
async function offerSavedAuthProfileName(params: {
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
    if (updated?.profiles[profileId]?.displayName === displayName) {
      return;
    }
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      runtime.log("The account is connected without a custom name.");
      return;
    }
  }
  if (params.signal?.aborted) {
    return;
  }
  const warning =
    "The account is connected, but OpenClaw could not save its name. You can keep its current label or set a display name in OpenClaw config (auth.profiles.<profile-id>.displayName).";
  try {
    // A plain wizard note stays visible in Models and also reaches the hosted CLI.
    await (prompter.plain ? prompter.plain(warning, { optional: true }) : prompter.note(warning));
  } catch {
    // A closed prompt or failed notification cannot undo the completed sign-in.
    runtime.error(warning);
  }
}
