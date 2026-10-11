import { expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import * as chatSession from "./server-methods/chat-send-session.js";
import {
  dashboardTitleScheduleMocks,
  setupSessionCreateTestHarness,
} from "./server.sessions.create.test-support.js";
import { dispatchInboundMessageMock, rpcReq, testState } from "./test-helpers.js";
import { getGatewayConfigModule } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupSessionCreateTestHarness();

test.each([
  { role: "administrator", scopes: ["operator.admin"] },
  { role: "operator", scopes: ["operator.write", "operator.read"] },
])(
  "sessions.create retains its first message across unrelated agent changes for $role",
  async ({ scopes }) => {
    const { storePath } = await createSessionStoreDir();
    testState.agentsConfig = { ownership: "explicit", entries: { main: {}, other: {} } };
    testState.agentConfig = { systemAgent: { agentId: "main" }, sessionStore: { agentId: "main" } };
    const { ws } = await openClient({ scopes });
    const config = await getGatewayConfigModule();
    const originalConfig = config.getRuntimeConfig();
    const prepareSession = chatSession.prepareChatSendSession;
    const prepare = vi.spyOn(chatSession, "prepareChatSendSession");
    dashboardTitleScheduleMocks.schedule.mockImplementation(() => {});
    try {
      for (const change of ["add", "remove"] as const) {
        const key = `agent:main:dashboard:initial-reload-${change}`;
        const message = `Keep this initial message across unrelated agent ${change}.`;
        const initial = createDeferred();
        const resume = createDeferred();
        const dispatched = createDeferred();
        prepare.mockImplementationOnce(async (options) => {
          const session = await prepareSession(options);
          initial.resolve();
          await resume.promise;
          return session;
        });
        dispatchInboundMessageMock.mockImplementationOnce(async ({ replyOptions }) => {
          await replyOptions?.userTurnTranscriptRecorder?.persistApproved();
          dispatched.resolve();
          return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
        });
        const request = rpcReq<{ key: string; runStarted: boolean }>(ws, "sessions.create", {
          agentId: "main",
          key,
          message,
        });
        try {
          await awaitGateBeforeSettlement(
            initial.promise,
            request.then((response) => {
              throw new Error(`creation skipped its initial turn: ${JSON.stringify(response)}`);
            }),
            "creation skipped its initial turn",
          );
          const current = config.getRuntimeConfig();
          const entries = { ...current.agents?.entries };
          if (change === "add") {
            entries.unrelated = {};
          } else {
            delete entries.unrelated;
          }
          // Publish after chat has captured its routing facts, before initial input admission.
          config.setRuntimeConfigSnapshot({ ...current, agents: { ...current.agents, entries } });
          resume.resolve();
          const created = await request;
          expect(created, JSON.stringify(created)).toMatchObject({
            ok: true,
            payload: { key, runStarted: true },
          });
          await dispatched.promise;
          const history = await rpcReq<{ messages: Array<{ role: string; content: unknown }> }>(
            ws,
            "chat.history",
            { sessionKey: key },
          );
          expect(history.ok, JSON.stringify(history)).toBe(true);
          expect(
            JSON.stringify(history.payload?.messages.find((item) => item.role === "user")),
          ).toContain(message);
        } finally {
          resume.resolve();
          await request;
          await getSessionWorkAdmissionRelease({ scope: storePath, identities: [key] });
        }
      }
    } finally {
      prepare.mockRestore();
      config.setRuntimeConfigSnapshot(originalConfig);
      ws.terminate();
    }
  },
);
