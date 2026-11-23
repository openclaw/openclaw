import { captureSessionEntryView } from "../config/sessions/session-entry-view.js";
import { prepareGitHubPublicationSession } from "./github-publication-availability.js";
import { readParticipantPublicationAuthority } from "./github-publication-participation.js";
import { prepareGitHubPublicationRequesterV2 } from "./github-publication-requester.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

type Request = Pick<
  GatewayRequestHandlerOptions,
  "client" | "context" | "signal" | "sessionMutationAuthorization"
>;

/** Only exact-session participant publication can use the retained principal instead of a human socket. */
export async function prepareParticipantPublicationRead(
  options: Request,
  params: { sessionKey: string; agentId?: string },
  signal?: AbortSignal,
) {
  if (
    !options.sessionMutationAuthorization?.participationCeiling &&
    !readParticipantPublicationAuthority("sessions.github.options", params)
  ) {
    return undefined;
  }
  const resources = new DisposableStack();
  try {
    const assertInvocation = () => {
      signal?.throwIfAborted();
      options.signal?.throwIfAborted();
      options.sessionMutationAuthorization?.assertCurrent();
    };
    const selected = await prepareGitHubPublicationSession(params.sessionKey, {
      agentId: params.agentId,
      assertCurrent: assertInvocation,
    });
    resources.defer(selected.release);
    const loaded = selected.readCurrent();
    if (!loaded.entry || loaded.entry.archivedAt !== undefined) {
      throw new Error("Participant publication session is unavailable.");
    }
    const session = {
      agentId: loaded.agentId,
      sessionKey: loaded.canonicalKey,
      sessionId: loaded.entry.sessionId,
      lifecycleRevision: loaded.entry.lifecycleRevision ?? null,
      archivedAt: loaded.entry.archivedAt ?? null,
    };
    const view = captureSessionEntryView(session, ["sessionId", "lifecycleRevision", "archivedAt"]);
    const admitted = await prepareGitHubPublicationRequesterV2(options, session);
    resources.defer(admitted.release);
    const assertCurrent = () => {
      assertInvocation();
      admitted.requester.assertCurrent();
      selected.readCurrent();
    };
    return {
      session,
      release: () => resources.dispose(),
      [Symbol.dispose]: () => resources.dispose(),
      sessionScoped: true,
      currentSession: () => {
        assertCurrent();
        return session;
      },
      currentSessionRead: () => {
        assertCurrent();
        return selected.readCurrent();
      },
      assertSessionUnchanged: (snapshot: {
        sessionId: string;
        lifecycleRevision: string | null;
        archivedAt: number | null;
      }) => {
        assertCurrent();
        if (!view.matches(snapshot)) {
          throw new Error("Participant publication session changed.");
        }
      },
    };
  } catch (error) {
    resources.dispose();
    throw error;
  }
}
