import { sessionCreatorProfileId } from "../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import type {
  PreparedSessionSourceFacts,
  SessionFactsRead,
} from "./session-sharing-target.types.js";

/** Borrow existing sharing/profile owners; a direct label does not identify private readers. */
export async function prepareSessionPersonalContext(params: {
  getConfig: () => OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  profileId?: string;
}) {
  const requestedProfileId = params.profileId;
  if (!requestedProfileId || !params.sessionKey) {
    return undefined;
  }
  const profiles = await prepareUserProfileCatalog();
  let session: SessionFactsRead<PreparedSessionSourceFacts> | undefined;
  try {
    const profileId = profiles.readCurrentIdentity(requestedProfileId)?.profileId;
    if (!profileId) {
      profiles.release();
      return undefined;
    }
    session = await prepareSessionMutationFacts({
      cfg: params.getConfig(),
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      allowMissing: true,
    });
    const selectedSession = session;
    const admitted = () => {
      const target = selectedSession.readCurrent(params.getConfig()).target;
      const creator = sessionCreatorProfileId(target?.entry.createdActor);
      return Boolean(
        profiles.readCurrentIdentity(requestedProfileId)?.profileId === profileId &&
        target &&
        (!params.sessionId || target.entry.sessionId === params.sessionId) &&
        target.entry.visibility === "draft" &&
        !target.entry.publicShare &&
        creator &&
        profiles.readCurrentIdentity(creator)?.profileId === profileId,
      );
    };
    if (!admitted()) {
      session.release();
      profiles.release();
      return undefined;
    }
    return {
      assertCurrent() {
        if (!admitted()) {
          throw new Error(
            "Personal context audience changed; reopen a private draft conversation.",
          );
        }
      },
      [Symbol.dispose]() {
        selectedSession.release();
        profiles.release();
      },
    };
  } catch (error) {
    session?.release();
    profiles.release();
    throw error;
  }
}
