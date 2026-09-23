import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { listSessionMembers } from "../../config/sessions/session-sharing-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as userProfileReads from "../../state/user-profile-reads.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import { identifiedClient, sessionSharingTestContext } from "./sessions-sharing.test-support.js";

it.each(["session.members.list", "session.members.add"] as const)(
  "rechecks the current manager after profile enumeration for %s",
  async (method) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:profile-enumeration-authority";
      const owner = ensureProfileForEmail("owner-enumeration@example.test");
      const foreign = ensureProfileForEmail("foreign-enumeration@example.test");
      const member = ensureProfileForEmail("member-enumeration@example.test");
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "profile-enumeration-authority",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: owner.id },
        },
      );
      const client = identifiedClient(owner.id);
      const requestContext = sessionSharingTestContext(vi.fn());
      await initializeSessionReadContext(requestContext);
      const ready = createDeferredCore();
      const release = createDeferredCore();
      const enumerate = userProfileReads.listProfiles;
      const read = vi.spyOn(userProfileReads, "listProfiles").mockImplementationOnce(async () => {
        const profiles = await enumerate().catch((error: unknown) => {
          ready.reject(error);
          throw error;
        });
        ready.resolve();
        await release.promise;
        return profiles;
      });
      const respond = vi.fn();
      const pending = sessionSharingHandlers[method]!({
        params: {
          sessionKey,
          ...(method === "session.members.add" ? { identityId: member.id } : {}),
        },
        context: requestContext,
        client,
        respond,
      } as never);
      const rejected = expect(pending).rejects.toThrow(/session .* before sharing/);
      try {
        await ready.promise;
        client.authenticatedUserProfile = identifiedClient(foreign.id).authenticatedUserProfile;
        release.resolve();
        await rejected;
        expect(respond).not.toHaveBeenCalled();
        expect(listSessionMembers({ agentId: "main", sessionKey })).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
        read.mockRestore();
      }
    });
  },
);
