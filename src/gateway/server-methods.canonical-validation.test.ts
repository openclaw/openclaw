import { afterEach, expect, it, vi } from "vitest";
import * as archiveWorker from "../config/sessions/session-accessor.sqlite-archive.js";
import { ensureSessionEntrySync } from "../config/sessions/session-accessor.sqlite-initial-entry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { method: "sessions.patch", change: "scope", expectedCode: "FORBIDDEN" },
  { method: "sessions.patch", change: "startup", expectedCode: "UNAVAILABLE" },
  { method: "talk.session.create", change: "none", expectedCode: undefined },
])(
  "restarts $method authorization after canonical readiness ($change)",
  async ({ method, change, expectedCode }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:canonical-readiness";
      ensureSessionEntrySync(
        { agentId: "main", sessionKey },
        {
          sessionId: "canonical-readiness",
          updatedAt: 1,
          visibility: "shared",
        },
      );
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      database.db
        .prepare("UPDATE session_nodes SET entry_json = entry_json || ' ' WHERE session_key = ?")
        .run(sessionKey);
      database.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(sessionKey);
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
      const scopes = ["operator.write"];
      const unavailableGatewayMethods = new Set<string>();
      const createWorker = archiveWorker.createSqliteTranscriptArchiveWorker;
      const started = vi
        .spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker")
        .mockImplementation((data) => {
          if (change === "scope") {
            scopes.splice(0, scopes.length, "operator.read");
          } else if (change === "startup") {
            unavailableGatewayMethods.add(method);
          }
          return createWorker(data);
        });
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) =>
        respond(true, { allowed: true }),
      );
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: `canonical-${change}`,
          method,
          params: method === "sessions.patch" ? { key: sessionKey } : { sessionKey },
        },
        respond,
        client: {
          connId: "canonical-readiness",
          authenticatedUserId: "member@example.com",
          authenticatedUserProfile: {
            profileId: "member",
            displayName: "Member",
            hasAvatar: false,
            updatedAt: 1,
          },
          connect: {
            role: "operator",
            scopes,
            client: { id: "test", version: "1", platform: "test", mode: "test" },
            minProtocol: 1,
            maxProtocol: 1,
          },
        } as Parameters<typeof handleGatewayRequest>[0]["client"],
        isWebchatConnect: () => false,
        context: {
          getRuntimeConfig: () => ({}),
          logGateway: { warn: vi.fn() },
          unavailableGatewayMethods,
        } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
        extraHandlers: { [method]: handler },
      });
      expect(started).toHaveBeenCalledOnce();
      if (expectedCode) {
        expect(handler).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: expectedCode }),
        );
      } else {
        // Talk's target resolver catches arbitrary read errors. The private signal
        // must still cause readiness, never become its user-facing error response.
        expect(handler).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledWith(true, { allowed: true });
      }
    });
  },
);
