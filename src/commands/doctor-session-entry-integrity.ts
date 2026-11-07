import type { SessionEntry } from "../config/sessions/types.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import { readUserModelAuthProfile } from "../state/user-model-accounts.js";

/** Inspect saved selectors without changing account ownership or loading transcripts. */
export function createDoctorSessionEntryInspector(params: {
  mainKey: string;
  env: NodeJS.ProcessEnv;
  warnings: string[];
}) {
  let mainEntry: SessionEntry | undefined;
  const personalAccountAvailability = new Map<string, boolean>();
  return {
    get mainEntry() {
      return mainEntry;
    },
    inspect(sessionKey: string, entry: SessionEntry) {
      if (sessionKey === params.mainKey) {
        mainEntry = entry;
      }
      const profileId = entry.authProfileOverride;
      if (!profileId || !isUserModelAuthProfileId(profileId)) {
        return;
      }
      let available = personalAccountAvailability.get(profileId);
      if (available === undefined) {
        available = readUserModelAuthProfile(profileId, { env: params.env }) !== undefined;
        personalAccountAvailability.set(profileId, available);
      }
      if (!available) {
        params.warnings.push(
          `- ${sessionKey}: selected personal model account is unavailable. Select another account for this session with /model <provider>/<model>@<profile>, or reconnect the intended account in Settings > Profile > Connected accounts and then explicitly select the newly connected account for this session. The saved pin was retained.`,
        );
      }
    },
  };
}
