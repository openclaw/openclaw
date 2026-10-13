import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import * as publicationAvailability from "../github-publication-availability.js";
import {
  publisher,
  receipt,
  sessionKey,
  withReadFixture,
} from "./sessions-github-read.test-support.js";

beforeEach(() => {
  vi.spyOn(
    publicationAvailability,
    "prepareCurrentGitHubPublicationOptionsIdentity",
  ).mockResolvedValue({
    source: publisher.source,
    account: { accountId: publisher.accountId, login: publisher.login, avatarUrl: null },
  });
});
afterEach(() => vi.restoreAllMocks());

const methods = ["sessions.github.options", "sessions.github.status"] as const;
function params(method: (typeof methods)[number]) {
  return {
    sessionKey,
    ...(method === "sessions.github.status" ? { requestId: receipt.result.requestId } : {}),
  };
}

function expectNoPersonalReads(fixture: Parameters<Parameters<typeof withReadFixture>[0]>[0]) {
  expect(fixture.personalConnectionStatus).not.toHaveBeenCalled();
  expect(fixture.personalPending).not.toHaveBeenCalled();
  expect(fixture.preparePersonalStatus).not.toHaveBeenCalled();
  expect(fixture.personalStatus).not.toHaveBeenCalled();
  expect(fixture.requestForSession).not.toHaveBeenCalled();
}

describe.each(methods)("registered guest %s", (method) => {
  it.each([
    { scope: "operator.sessions.read", foreign: false, others: "view", missing: false },
    { scope: "operator.sessions.write", foreign: false, others: "view", missing: false },
    { scope: "operator.sessions.write", foreign: true, others: "view", missing: false },
    { scope: "operator.sessions.write", foreign: true, others: "none", missing: false },
    ...(method === "sessions.github.status"
      ? [
          {
            scope: "operator.sessions.write",
            foreign: false,
            others: "view",
            missing: true,
          } as const,
        ]
      : []),
  ] as const)(
    "keeps $scope foreign=$foreign others=$others missing=$missing visibility and personal boundaries",
    async ({ scope, foreign, others, missing }) => {
      await withReadFixture(
        async (fixture) => {
          if (missing) {
            fixture.sharedStatus.mockResolvedValue(undefined);
          }
          const respond = await fixture.invoke(method, params(method));
          if (foreign && others === "none") {
            expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
            expect(fixture.latestShared).not.toHaveBeenCalled();
            expect(fixture.sharedStatus).not.toHaveBeenCalled();
          } else if (missing) {
            expect(respond).toHaveBeenCalledWith(
              false,
              undefined,
              expect.objectContaining({ code: "FORBIDDEN" }),
            );
            expect(fixture.sharedStatus).toHaveBeenCalledOnce();
          } else {
            expect(respond).toHaveBeenCalledWith(
              true,
              method === "sessions.github.options"
                ? {
                    personal: null,
                    shared: null,
                    sharedUnavailableReason: "unsupported_workspace",
                    pendingPersonal: null,
                    latestShared: receipt,
                  }
                : receipt,
            );
          }
          expectNoPersonalReads(fixture);
        },
        { personal: true, scopes: [scope], others, foreign },
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
          const entered = createDeferredCore();
          const pending = createDeferredCore<typeof receipt>();
          const sharedRead =
            method === "sessions.github.options" ? fixture.latestShared : fixture.sharedStatus;
          sharedRead.mockImplementationOnce(() => {
            entered.resolve();
            return pending.promise;
          });
          const respond = vi.fn();
          const request = fixture.invoke(method, params(method), respond);
          try {
            await awaitGateBeforeSettlement(entered.promise, request, "Receipt read did not start");
            expect(respond).not.toHaveBeenCalled();
            if (change === "scope") {
              fixture.client.connect.scopes = [];
            } else if (change === "role") {
              await setCanonicalUserProfileRole(
                expectDefined(fixture.client.authenticatedUserProfile, "guest profile").profileId,
                "blocked",
              );
            } else if (change === "profile") {
              expectDefined(fixture.client.authenticatedUserProfile, "guest profile").profileId =
                ensureProfileForEmail("replacement-publication-reader@example.test").id;
            } else if (change === "grant") {
              granted.abort();
            } else if (change === "connection") {
              fixture.disconnect();
            } else if (change === "visibility") {
              await upsertSessionEntryCore(
                { agentId: "main", sessionKey },
                { visibility: "draft" },
              );
            } else {
              await upsertSessionEntryCore(
                { agentId: "main", sessionKey },
                { lifecycleRevision: "replaced-publication" },
              );
            }
            pending.resolve(receipt);
            await request;
            expect(sharedRead).toHaveBeenCalledOnce();
            expect(respond).toHaveBeenCalledExactlyOnceWith(
              false,
              undefined,
              expect.objectContaining({ code: "FORBIDDEN" }),
            );
            expectNoPersonalReads(fixture);
          } finally {
            pending.resolve(receipt);
            await request;
          }
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
