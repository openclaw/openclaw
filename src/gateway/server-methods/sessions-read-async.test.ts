import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  identifiedClient,
  listSessions,
  profileSessionEntry,
  requestContext,
} from "./sessions-read-cache.test-support.js";
import { sessionRoleConfig } from "./sessions-rewind.handler.test-support.js";

afterEach(() => vi.restoreAllMocks());

const viewerConfig = (others: "view" | "none") =>
  sessionRoleConfig("viewer", {
    agents: "*",
    scopes: ["operator.read", "operator.write"],
    sessions: { others },
  });

it.each([
  "membership-unpublished",
  "membership-external",
  "visibility",
  "identity",
  "config",
] as const)(
  "rechecks current %s after the resident projection has completed asynchronous preparation",
  (change) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const viewer = ensureProfileForEmail("page-viewer@example.test").id;
      const owner = ensureProfileForEmail("page-owner@example.test").id;
      const scope = { agentId: "main", sessionKey: "agent:main:selected-page" };
      const membershipChange = change.startsWith("membership");
      const replacementKey = "agent:main:replacement-page";
      const seed = (entry: SessionEntry) => {
        replaceSessionEntrySync({ ...scope, sessionKey: `agent:main:${entry.sessionId}` }, entry);
        return entry;
      };
      const [selectedOwner, otherOwner]: [string, string] =
        change === "identity" ? [viewer, owner] : [owner, viewer];
      const selected = seed({
        ...profileSessionEntry("selected-page", 300, selectedOwner),
        visibility: change === "identity" ? "draft" : membershipChange ? "read-only" : "shared",
      });
      seed(profileSessionEntry("replacement-page", 200, otherOwner));
      seed(profileSessionEntry("tail-page", 100, otherOwner));
      if (membershipChange) {
        addSessionMember(scope, { identityId: viewer, addedBy: owner });
      }
      let config = viewerConfig("view");
      const context = requestContext(config);
      context.getRuntimeConfig = () => config;
      const client = identifiedClient(viewer);
      const request = { agentId: "main", limit: 1, includeActivitySummary: true };
      const before = await listSessions({ client, context, request });
      expect(before.sessions).toMatchObject([
        { key: scope.sessionKey, sessionId: selected.sessionId },
      ]);
      const projection = expectDefined(getSessionRowProjection(context), "resident projection");
      const ready = projection.prepareSelection.bind(projection);
      vi.spyOn(projection, "prepareSelection").mockImplementationOnce(async (...args) => {
        await ready(...args);
        // Resume the real request only after its current authority has changed.
        if (change === "config") {
          config = viewerConfig("none");
          setRuntimeConfigSnapshot(config);
        } else if (change === "identity") {
          client.authenticatedUserProfile = {
            ...client.authenticatedUserProfile!,
            profileId: owner,
          };
        } else {
          if (change === "membership-external") {
            const external = new DatabaseSync(openOpenClawAgentDatabase(scope).path);
            try {
              external
                .prepare("DELETE FROM session_members WHERE session_key = ? AND identity_id = ?")
                .run(scope.sessionKey, viewer);
            } finally {
              external.close();
            }
            // External writers publish committed changes through their owning bridge.
            sessionChanges.emit({ ...scope, factsInvalidated: true });
          } else if (membershipChange) {
            expect(removeSessionMember(scope, viewer)).not.toBeNull();
          } else {
            replaceSessionEntrySync(scope, {
              ...selected,
              visibility: "draft",
            });
          }
          if (change === "visibility") {
            emitSessionsChanged(context, { reason: "sharing", sessionKey: scope.sessionKey });
          }
        }
      });

      const result = await listSessions({ client, context, request });
      if (membershipChange) {
        expect(result.sessions).toMatchObject([
          { key: scope.sessionKey, sharingRole: "viewer", activitySummary: { canEnsure: false } },
        ]);
      } else {
        expect(result.sessions.map((session) => session.key)).toEqual([replacementKey]);
        expect(result).toMatchObject({ count: 1, nextOffset: 1 });
      }
    }),
);
