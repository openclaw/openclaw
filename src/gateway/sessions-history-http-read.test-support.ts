import { expect, test, vi } from "vitest";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { withSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import * as sessionHistoryState from "./session-history-state.js";
import {
  makeTranscriptAssistantMessage,
  withGatewayHarness,
} from "./sessions-history-http.test-support.js";

const READ_SCOPE_HEADER = { "x-openclaw-scopes": "operator.read" };
const AGENT_ID = "main";

export async function fetchSessionHistory(
  port: number,
  sessionKey: string,
  params?: {
    query?: string;
    headers?: Record<string, string>;
  },
) {
  return fetch(
    `http://127.0.0.1:${port}/sessions/${encodeURIComponent(sessionKey)}/history${params?.query ?? ""}`,
    { headers: { ...READ_SCOPE_HEADER, ...params?.headers } },
  );
}

export type SessionHistoryMessage = {
  role?: string;
  content?: Array<{ text?: string }>;
  __openclaw?: { id?: string; seq?: number; turnBoundary?: boolean };
};

export type SessionHistoryBody = {
  sessionKey?: string;
  items?: SessionHistoryMessage[];
  messages?: SessionHistoryMessage[];
  nextCursor?: string;
  hasMore?: boolean;
};

export async function readSessionHistoryBody(
  port: number,
  sessionKey: string,
  params?: Parameters<typeof fetchSessionHistory>[2],
): Promise<SessionHistoryBody> {
  const res = await fetchSessionHistory(port, sessionKey, params);
  expect(res.status).toBe(200);
  return (await res.json()) as SessionHistoryBody;
}

export function expectErrorResponse(body: unknown, expected: { type: string; message: string }) {
  expect(body).toEqual({ ok: false, error: expected });
}

export function registerMemorySessionHistoryTests(
  createSessionStoreFile: () => Promise<string>,
): void {
  test("reads unbound memory history without creating missing owners and withholds a closed owner's snapshot", async () => {
    await createSessionStoreFile();
    await withGatewayHarness(async (harness) => {
      const sessionKey = "agent:main:dashboard:incognito-http-history";
      const sessionId = "memory-http-history";
      const text = "Private memory reply";
      const location = {
        agentId: AGENT_ID,
        path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: AGENT_ID }),
      };
      expect(memorySessionActorOwners.read(location)).toBeUndefined();
      try {
        const missing = await fetchSessionHistory(harness.port, sessionKey);
        expect(missing.status).toBe(404);
        expectErrorResponse(await missing.json(), {
          type: "not_found",
          message: `Session not found: ${sessionKey}`,
        });
        expect(memorySessionActorOwners.read(location)).toBeUndefined();

        const authority = { assertCurrent() {}, authorize() {} };
        const created = await withSessionActorStorage(
          { agentId: AGENT_ID, sessionKey, storePath: location.path },
          {
            create: true,
            authority,
            lifetime: { assertCurrent() {}, assertReadable() {} },
          },
          ({ actor }) =>
            actor.storage.mutate(
              {
                type: "session.entry.create",
                input: {
                  entry: {
                    sessionId,
                    updatedAt: Date.now(),
                    incognito: true,
                    lifecycleRevision: "memory-http-lifecycle",
                  },
                  transcriptEvents: [
                    { type: "session", id: sessionId, version: 3, cwd: "/synthetic" },
                    {
                      type: "message",
                      id: "memory-http-reply",
                      parentId: null,
                      message: makeTranscriptAssistantMessage({ text }),
                    },
                  ],
                },
              },
              authority,
            ),
        );
        expect(created?.kind).toBe("committed");

        const history = await readSessionHistoryBody(harness.port, sessionKey);
        expect(history.sessionKey).toBe(sessionKey);
        expect(history.messages?.map((message) => message.content?.[0]?.text)).toEqual([text]);

        const readSnapshot = sessionHistoryState.readSessionHistorySnapshotAsync;
        const snapshotSpy = vi
          .spyOn(sessionHistoryState, "readSessionHistorySnapshotAsync")
          .mockImplementationOnce(async (params) => {
            const snapshot = await readSnapshot(params);
            memorySessionActorOwners.closeDatabase(location);
            return snapshot;
          });
        try {
          const closed = await fetchSessionHistory(harness.port, sessionKey);
          expect(closed.status).toBe(404);
          expectErrorResponse(await closed.json(), {
            type: "not_found",
            message: `Session not found: ${sessionKey}`,
          });
          expect(snapshotSpy).toHaveBeenCalledOnce();
          expect(memorySessionActorOwners.read(location)).toBeUndefined();
        } finally {
          snapshotSpy.mockRestore();
        }
      } finally {
        memorySessionActorOwners.closeDatabase(location);
      }
    });
  });
}
