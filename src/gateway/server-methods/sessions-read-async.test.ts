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
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

function viewerConfig(others: "view" | "none"): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "viewer",
        definitions: {
          viewer: {
            agents: "*",
            scopes: ["operator.read", "operator.write"],
            sessions: { others },
          },
        },
      },
    },
  };
}

it.each([
  "membership",
  "membership-unpublished",
  "membership-external",
  "visibility",
  "identity",
  "config",
] as const)(
  "rechecks current %s after the resident projection has completed asynchronous preparation",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const viewer = ensureProfileForEmail("page-viewer@example.test").id;
      const owner = ensureProfileForEmail("page-owner@example.test").id;
      const scope = { agentId: "main", sessionKey: "agent:main:selected-page" };
      const membershipChange = change.startsWith("membership");
      const replacementKey = "agent:main:replacement-page";
      const selected: SessionEntry = {
        sessionId: "selected-page",
        updatedAt: 300,
        visibility: change === "identity" ? "draft" : membershipChange ? "read-only" : "shared",
        createdActor: {
          type: "human",
          source: "profile",
          id: change === "identity" ? viewer : owner,
        },
      };
      replaceSessionEntrySync(scope, selected);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: replacementKey },
        {
          sessionId: "replacement-page",
          updatedAt: 200,
          visibility: "shared",
          createdActor: {
            type: "human",
            source: "profile",
            id: change === "identity" ? owner : viewer,
          },
        },
      );
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:tail-page" },
        {
          sessionId: "tail-page",
          updatedAt: 100,
          visibility: "shared",
          createdActor: {
            type: "human",
            source: "profile",
            id: change === "identity" ? owner : viewer,
          },
        },
      );
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
      const ready = projection.ensureMaterialized.bind(projection);
      vi.spyOn(projection, "ensureMaterialized").mockImplementationOnce(async () => {
        await ready();
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
          if (change === "membership" || change === "visibility") {
            emitSessionsChanged(context, { reason: "sharing", sessionKey: scope.sessionKey });
          }
        }
      });

      const result = await listSessions({
        client,
        context,
        request,
      });
      if (membershipChange) {
        expect(result.sessions).toMatchObject([
          { key: scope.sessionKey, sharingRole: "viewer", activitySummary: { canEnsure: false } },
        ]);
      } else {
        expect(result.sessions.map((session) => session.key)).toEqual([replacementKey]);
        expect(result).toMatchObject({ count: 1, nextOffset: 1 });
      }
    });
  },
);
