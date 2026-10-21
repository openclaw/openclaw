import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  expectFailure,
  expectNoPersonalReads,
  expectReply,
  mockPublicationIdentity,
  optionsResult,
  receipt,
  sessionKey,
  withHeldReceipt,
  withReadFixture,
} from "./sessions-github-read.test-support.js";

beforeEach(mockPublicationIdentity);
afterEach(() => vi.restoreAllMocks());

describe.each(["options", "status"] as const)("registered guest sessions.github.%s", (method) => {
  it.each([
    ["read", false, "view", false],
    ["write", false, "view", false],
    ["write", true, "view", false],
    ["write", true, "none", false],
    ...(method === "status" ? [["write", false, "view", true] as const] : []),
  ] as const)(
    "keeps %s foreign=%s others=%s missing=%s visibility and personal boundaries",
    async (scope, foreign, others, missing) => {
      await withReadFixture(
        async (fixture) => {
          if (missing) {
            fixture.sharedStatus.mockResolvedValue(undefined);
          }
          const respond = await fixture[method]();
          if (foreign && others === "none") {
            expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
            expect(fixture.latestShared).not.toHaveBeenCalled();
            expect(fixture.sharedStatus).not.toHaveBeenCalled();
          } else if (missing) {
            expectFailure(respond);
            expect(fixture.sharedStatus).toHaveBeenCalledOnce();
          } else {
            expectReply(
              respond,
              method === "options"
                ? optionsResult({
                    shared: null,
                    sharedUnavailableReason: "unsupported_workspace",
                  })
                : receipt,
            );
          }
          expectNoPersonalReads(fixture);
        },
        { personal: true, scopes: [`operator.sessions.${scope}`], others, foreign },
      );
    },
  );

  it.each(["scope", "role", "profile", "grant", "connection", "visibility", "lifecycle"] as const)(
    "rejects %s loss during an awaited receipt read",
    async (change) => {
      await withReadFixture(
        async (fixture) => {
          const granted = new AbortController();
          fixture.client.internal = {
            operatorAccessAuthority: {
              signal: granted.signal,
              assertCurrent: () => granted.signal.throwIfAborted(),
            },
          };
          await withHeldReceipt(
            fixture,
            method === "options" ? "shared" : "status",
            async (respond, release) => {
              const profile = expectDefined(
                fixture.client.authenticatedUserProfile,
                "guest profile",
              );
              const updateSession = (patch: Parameters<typeof upsertSessionEntryCore>[1]) =>
                upsertSessionEntryCore({ agentId: "main", sessionKey }, patch);
              await {
                scope: () => {
                  fixture.client.connect.scopes = [];
                },
                role: () => setCanonicalUserProfileRole(profile.profileId, "blocked"),
                profile: () => {
                  profile.profileId = ensureProfileForEmail(
                    "replacement-publication-reader@example.test",
                  ).id;
                },
                grant: () => granted.abort(),
                connection: fixture.disconnect,
                visibility: () => updateSession({ visibility: "draft" }),
                lifecycle: () => updateSession({ lifecycleRevision: "replaced-publication" }),
              }[change]();
              await release(receipt);
              expectFailure(respond);
              expect(respond).toHaveBeenCalledOnce();
              expectNoPersonalReads(fixture);
            },
          );
        },
        {
          personal: true,
          scopes: ["operator.sessions.write"],
          others: change === "visibility" ? "view" : "none",
          foreign: change === "visibility",
        },
      );
    },
  );
});
