import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { FailoverError } from "../agents/failover-error.js";
import { ToolAuthorizationError } from "../agents/tool-input-error.js";
import { recordAgentRunTerminalOutcome } from "../channels/turn/agent-run-terminal-outcome.js";
import * as logger from "../logger.js";
import { seedPluginStateEntriesForTests } from "../plugin-state/plugin-state-store.test-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import * as authPolicy from "./auth-policy.js";
import { findSseEvent, parseSseEvents } from "./http-stream.test-support.js";
import type { ResponseResource } from "./open-responses.schema.js";
import { rememberResponseSession } from "./openresponses-session-store.js";
import * as responseSessions from "./openresponses-session-store.js";
import { agentCommandMock } from "./test-helpers.js";

export function registerOpenResponsesContinuationTests({
  getPort,
  postResponses,
  mockAgentOnce,
  firstAgentOpts,
  expectInvalidRequest,
  ensureResponseConsumed,
}: {
  getPort: () => number;
  postResponses: (
    port: number,
    body: unknown,
    headers?: Record<string, string>,
  ) => Promise<Response>;
  mockAgentOnce: (payloads: Array<{ text: string }>) => void;
  firstAgentOpts: (callIndex?: number) => Record<string, unknown>;
  expectInvalidRequest: (response: Response, pattern: RegExp) => Promise<unknown>;
  ensureResponseConsumed: (response: Response) => Promise<void>;
}) {
  it.each([false, true])(
    "continues across user values but rejects unknown response IDs (stream=%s)",
    async (stream) => {
      const request = { model: "openclaw", input: "hi" };
      mockAgentOnce([{ text: "First turn." }]);
      const first = await postResponses(getPort(), { ...request, user: "alice" });
      expect(first.status).toBe(200);
      const { id } = (await first.json()) as { id: string };
      const sessionKey = firstAgentOpts().sessionKey;
      expect(sessionKey).toContain("openresponses-user:alice");
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "Second turn." }] } as never);
      const continued = await postResponses(getPort(), {
        ...request,
        stream,
        user: "bob",
        previous_response_id: id,
      });
      expect(continued.status).toBe(200);
      await ensureResponseConsumed(continued);
      expect(firstAgentOpts(1).sessionKey).toBe(sessionKey);

      agentCommandMock.mockClear();
      for (const mismatch of [
        { responseId: `foreign-agent-${stream}`, agentId: "another-agent" },
        { responseId: `foreign-session-${stream}`, requestedSessionKey: "another-session" },
      ]) {
        await rememberResponseSession(
          {
            authSubject: "gateway-auth:none",
            agentId: "main",
            sessionKey: "agent:main:openresponses:unreachable",
            ...mismatch,
          },
          () => {},
        );
      }
      seedPluginStateEntriesForTests([
        {
          pluginId: "core:openresponses",
          namespace: "response-sessions",
          key: `expired-${stream}`,
          value: {
            sessionKey: "agent:main:openresponses:unreachable",
            authSubject: "gateway-auth:none",
            agentId: "main",
          },
          expiresAt: Date.now() - 1,
        },
      ]);
      for (const previousId of [
        "missing",
        "",
        " ",
        "x".repeat(513),
        ` ${id}`,
        `expired-${stream}`,
        `foreign-agent-${stream}`,
        `foreign-session-${stream}`,
      ]) {
        const payload = { ...request, stream, previous_response_id: previousId };
        const response = await postResponses(getPort(), payload);
        await expectInvalidRequest(response, /previous_response_id.*full input context/);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(agentCommandMock).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects revoked request authority while a continuation lookup is pending", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const lookup = responseSessions.lookupResponseSession;
    const lookupSpy = vi
      .spyOn(responseSessions, "lookupResponseSession")
      .mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return lookup(...args);
      });
    agentCommandMock.mockClear();
    const pending = postResponses(getPort(), {
      model: "openclaw",
      input: "must not run",
      previous_response_id: "revoked-request",
    });
    await entered.promise;
    const policySpy = vi.spyOn(authPolicy, "isGatewayAuthPolicyCurrent").mockReturnValue(false);
    try {
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { message: "Unauthorized", type: "unauthorized" },
      });
      expect(agentCommandMock).not.toHaveBeenCalled();
    } finally {
      lookupSpy.mockRestore();
      policySpy.mockRestore();
    }
  });

  it("commits response continuity before replying and retains it after the store reopens", async () => {
    const port = getPort();
    const bearer = "synthetic-operator-password";
    const headers = { authorization: `Bearer ${bearer}` };
    agentCommandMock.mockClear();

    const entered = createDeferred();
    const result = createDeferred<{ payloads: Array<{ text: string }> }>();
    agentCommandMock.mockImplementationOnce(() => {
      entered.resolve();
      return result.promise as never;
    });

    const responsePromise = postResponses(
      port,
      { stream: false, model: "openclaw", input: "delayed hello" },
      headers,
    );

    await entered.promise;
    const pendingId = firstAgentOpts().runId;
    const sessionKey = firstAgentOpts().sessionKey;
    const pending = await postResponses(
      port,
      { model: "openclaw", input: "too early", previous_response_id: pendingId },
      headers,
    );
    await expectInvalidRequest(pending, /previous_response_id/);
    result.resolve({ payloads: [{ text: "hello" }] });

    const res = await responsePromise;
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id?: string };
    expect(json.id).toMatch(/^resp_/);
    const stored = openOpenClawStateDatabase()
      .db.prepare(
        "SELECT value_json FROM plugin_state_entries WHERE plugin_id = 'core:openresponses' AND namespace = 'response-sessions' AND entry_key = ?",
      )
      .get(json.id!);
    expect(stored?.value_json).toEqual(expect.any(String));
    expect(stored?.value_json).not.toContain(bearer);
    expect(stored?.value_json).not.toContain(createHash("sha256").update(bearer).digest("hex"));
    await closeOpenClawStateDatabaseAsync();
    const foreign = await postResponses(
      port,
      { model: "openclaw", input: "foreign bearer", previous_response_id: json.id },
      { authorization: "Bearer synthetic-different-password" },
    );
    await expectInvalidRequest(foreign, /previous_response_id/);
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "continued" }] } as never);
    const continued = await postResponses(
      port,
      { model: "openclaw", input: "continue after reopen", previous_response_id: json.id },
      headers,
    );
    expect(continued.status).toBe(200);
    await ensureResponseConsumed(continued);
    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    expect(firstAgentOpts(1).sessionKey).toBe(sessionKey);
  });

  it.each([
    { stream: false, runFails: false },
    { stream: true, runFails: false },
    { stream: false, runFails: true },
    { stream: true, runFails: true },
  ])(
    "reports persistence failure without masking the run error (%j)",
    async ({ stream, runFails }) => {
      const persistenceError = new Error("synthetic continuity write failed");
      const persistence = vi
        .spyOn(responseSessions, "rememberResponseSession")
        .mockRejectedValueOnce(persistenceError);
      const warnings = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
      agentCommandMock.mockClear();
      if (runFails) {
        agentCommandMock.mockRejectedValueOnce(
          new FailoverError("synthetic provider throttled", { reason: "rate_limit", status: 429 }),
        );
      } else {
        agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "done" }] } as never);
      }
      try {
        const response = await postResponses(getPort(), { model: "openclaw", input: "hi", stream });
        expect(response.status).toBe(stream ? 200 : runFails ? 429 : 500);
        const resource = stream
          ? (
              JSON.parse(
                findSseEvent(parseSseEvents(await response.text()), "response.failed").data,
              ) as {
                response: ResponseResource;
              }
            ).response
          : await response.json();
        expect(resource).toMatchObject({
          status: "failed",
          error: runFails
            ? { code: "rate_limit_error", message: "synthetic provider throttled" }
            : { code: "api_error", message: "internal error" },
        });
        expect(persistence).toHaveBeenCalledTimes(1);
        expect(warnings).toHaveBeenCalledWith(expect.stringContaining(persistenceError.message));
      } finally {
        persistence.mockRestore();
        warnings.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "preserves resolved failed-run responses when continuity persistence rejects (stream=%s)",
    async (stream) => {
      const privateDetail = "raw provider detail should stay private";
      const persistence = vi.spyOn(responseSessions, "rememberResponseSession");
      const warnings = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
      agentCommandMock.mockClear();
      try {
        for (const persistenceError of [
          undefined,
          new Error("synthetic continuity write failed"),
          new ToolAuthorizationError("synthetic continuity write denied"),
        ]) {
          if (persistenceError) {
            persistence.mockRejectedValueOnce(persistenceError);
          }
          agentCommandMock.mockResolvedValueOnce(
            recordAgentRunTerminalOutcome(
              {
                payloads: [{ text: "Command may have changed state", isError: true }],
                meta: {
                  error: { kind: "incomplete_turn", message: privateDetail },
                  agentMeta: {
                    sessionId: "failed-continuation-session",
                    provider: "openai",
                    model: "test-model",
                    usage: { input: 11, output: 7, total: 18 },
                  },
                },
              },
              "failed",
            ) as never,
          );

          const response = await postResponses(getPort(), {
            model: "openclaw",
            input: "hi",
            stream,
          });
          expect(response.status).toBe(stream ? 200 : 500);
          const body = await response.text();
          expect(body).not.toContain(privateDetail);
          let resource: ResponseResource;
          if (stream) {
            const events = parseSseEvents(body);
            expect(
              events
                .filter((event) =>
                  ["response.completed", "response.incomplete", "response.failed"].includes(
                    event.event ?? "",
                  ),
                )
                .map((event) => event.event),
            ).toEqual(["response.failed"]);
            expect(events.at(-1)?.data).toBe("[DONE]");
            resource = (
              JSON.parse(findSseEvent(events, "response.failed").data) as {
                response: ResponseResource;
              }
            ).response;
            expect(resource.usage).toMatchObject({
              input_tokens: 11,
              output_tokens: 7,
              total_tokens: 18,
            });
          } else {
            resource = JSON.parse(body) as ResponseResource;
          }
          expect(resource).toMatchObject({
            status: "failed",
            output: [],
            error: { code: "api_error", message: "internal error" },
          });
          if (persistenceError) {
            expect(warnings).toHaveBeenCalledWith(
              expect.stringContaining(persistenceError.message),
            );
          }
        }
        expect(agentCommandMock).toHaveBeenCalledTimes(3);
        expect(persistence).toHaveBeenCalledTimes(3);
      } finally {
        persistence.mockRestore();
        warnings.mockRestore();
      }
    },
  );
}
