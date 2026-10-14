import { afterAll, beforeAll, expect, it } from "vitest";
import { agentCommandFromGatewayIngress } from "../agents/agent-command.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import {
  agentCommandMock,
  getGatewayTestPort,
  installGatewayTestHooks,
  startGatewayServerWithRetries,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let started: Awaited<ReturnType<typeof startGatewayServerWithRetries>>;
beforeAll(async () => {
  started = await startGatewayServerWithRetries({
    port: await getGatewayTestPort(),
    opts: {
      host: "127.0.0.1",
      auth: { mode: "none" },
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: true,
      openResponsesEnabled: true,
    },
  });
});
afterAll(async () => started?.server.close({ reason: "archived HTTP session proof complete" }));

it.each([
  { endpoint: "/v1/chat/completions", input: { messages: [{ role: "user", content: "resume" }] } },
  { endpoint: "/v1/responses", input: { input: "resume" } },
])(
  "$endpoint preserves archived sessions and explains how to resume",
  async ({ endpoint, input }) => {
    const sessionKey = `agent:main:archived-http:${endpoint.split("/").at(-1)}`;
    const scope = { agentId: "main", sessionKey };
    const entry = {
      sessionId: `archived-${endpoint.split("/").at(-1)}`,
      updatedAt: Date.now(),
      archivedAt: 1,
      archiveReason: "age-retention" as const,
    };
    await upsertSessionEntryCore(scope, entry);
    const transcriptScope = { ...scope, sessionId: entry.sessionId };
    const history = [{ type: "message", message: { role: "user", content: "remember this" } }];
    await replaceTranscriptEvents(transcriptScope, history);
    const storedEntry = loadSessionEntry(scope);
    // Keep the HTTP fixture's server, but execute real command preparation and admission.
    agentCommandMock.mockImplementationOnce(async (...args) =>
      agentCommandFromGatewayIngress(
        ...(args as Parameters<typeof agentCommandFromGatewayIngress>),
      ),
    );

    const response = await fetch(`http://127.0.0.1:${started.port}${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openclaw-session-key": sessionKey,
        "x-openclaw-scopes": "operator.write",
      },
      body: JSON.stringify({ model: "openclaw", ...input }),
    });
    await expect(agentCommandMock.mock.results.at(-1)?.value).rejects.toThrow("is archived");
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatchObject({
      message: "Session is archived. Restore it in the Control UI before retrying.",
    });
    expect(body.error.type ?? body.error.code).toBe("invalid_request_error");
    expect(JSON.stringify(body)).not.toContain(sessionKey);
    expect(loadSessionEntry(scope)).toEqual(storedEntry);
    expect(await loadTranscriptEvents(transcriptScope)).toEqual(history);
  },
);
