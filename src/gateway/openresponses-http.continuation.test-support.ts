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
  const post = (body: Record<string, unknown> = {}, headers?: Record<string, string>) =>
    postResponses(getPort(), { model: "openclaw", input: "hi", ...body }, headers);
  const replyOnce = (text: string) =>
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text }] } as never);
  const scope = {
    authSubject: "gateway-auth:none",
    agentId: "main",
    sessionKey: "agent:main:openresponses:unreachable",
  };
  const terminal = new Set(["response.completed", "response.incomplete", "response.failed"]);

  it.each([false, true])(
    "continues across user values but rejects unknown response IDs (stream=%s)",
    async (stream) => {
      mockAgentOnce([{ text: "First turn." }]);
      const first = await post({ user: "alice" });
      expect(first.status).toBe(200);
      const { id } = (await first.json()) as { id: string };
      const sessionKey = firstAgentOpts().sessionKey;
      expect(sessionKey).toContain("openresponses-user:alice");
      replyOnce("Second turn.");
      const continued = await post({ stream, user: "bob", previous_response_id: id });
      expect(continued.status).toBe(200);
      await ensureResponseConsumed(continued);
      expect(firstAgentOpts(1).sessionKey).toBe(sessionKey);

      agentCommandMock.mockClear();
      for (const mismatch of [
        { responseId: `foreign-agent-${stream}`, agentId: "another-agent" },
        { responseId: `foreign-session-${stream}`, requestedSessionKey: "another-session" },
      ]) {
        await rememberResponseSession({ ...scope, ...mismatch }, () => {});
      }
      seedPluginStateEntriesForTests([
        {
          pluginId: "core:openresponses",
          namespace: "response-sessions",
          key: `expired-${stream}`,
          value: scope,
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
        const response = await post({ stream, previous_response_id: previousId });
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
    const pending = post({ previous_response_id: "revoked-request" });
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
    const bearer = "synthetic-operator-password";
    const headers = { authorization: `Bearer ${bearer}` };
    agentCommandMock.mockClear();

    const entered = createDeferred();
    const result = createDeferred<{ payloads: Array<{ text: string }> }>();
    agentCommandMock.mockImplementationOnce(() => {
      entered.resolve();
      return result.promise as never;
    });

    const responsePromise = post({ stream: false }, headers);
    await entered.promise;
    const { runId, sessionKey } = firstAgentOpts();
    const pending = await post({ previous_response_id: runId }, headers);
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
    const foreign = await post(
      { previous_response_id: json.id },
      { authorization: "Bearer synthetic-different-password" },
    );
    await expectInvalidRequest(foreign, /previous_response_id/);
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    replyOnce("continued");
    const continued = await post({ previous_response_id: json.id }, headers);
    expect(continued.status).toBe(200);
    await ensureResponseConsumed(continued);
    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    expect(firstAgentOpts(1).sessionKey).toBe(sessionKey);
  });

  it.each([
    { stream: false, run: "success" },
    { stream: false, run: "throws" },
    { stream: false, run: "failed" },
    { stream: true, run: "success" },
    { stream: true, run: "throws" },
    { stream: true, run: "failed" },
  ])("keeps run errors on persistence failure (%j)", async ({ stream, run }) => {
    const persistence = vi.spyOn(responseSessions, "rememberResponseSession");
    const warnings = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    agentCommandMock.mockClear();
    const privateDetail = "raw provider detail should stay private";
    const throttled = "synthetic provider throttled";
    const writeError = new Error("synthetic continuity write failed");
    const failures =
      run === "failed"
        ? [undefined, writeError, new ToolAuthorizationError("synthetic continuity write denied")]
        : [writeError];
    try {
      for (const persistenceError of failures) {
        if (persistenceError) {
          persistence.mockRejectedValueOnce(persistenceError);
        }
        if (run === "throws") {
          agentCommandMock.mockRejectedValueOnce(
            new FailoverError(throttled, { reason: "rate_limit", status: 429 }),
          );
        } else if (run === "success") {
          replyOnce("done");
        } else {
          agentCommandMock.mockResolvedValueOnce(
            recordAgentRunTerminalOutcome(
              {
                payloads: [{ text: "Command may have changed state", isError: true }],
                meta: {
                  error: { kind: "incomplete_turn", message: privateDetail },
                  agentMeta: { usage: { input: 11, output: 7, total: 18 } },
                },
              },
              "failed",
            ) as never,
          );
        }

        const response = await post({ stream });
        expect(response.status).toBe(stream ? 200 : run === "throws" ? 429 : 500);
        const body = await response.text();
        const events = stream ? parseSseEvents(body) : [];
        const resource: ResponseResource = stream
          ? JSON.parse(findSseEvent(events, "response.failed").data).response
          : JSON.parse(body);
        if (run === "failed") {
          expect(body).not.toContain(privateDetail);
          expect(resource.output).toEqual([]);
          if (stream) {
            expect(
              events.map(({ event }) => event).filter((event) => terminal.has(event ?? "")),
            ).toEqual(["response.failed"]);
            expect(events.at(-1)?.data).toBe("[DONE]");
            expect(resource).toMatchObject({
              usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
            });
          }
        }
        expect(resource).toMatchObject({
          status: "failed",
          error:
            run === "throws"
              ? { code: "rate_limit_error", message: throttled }
              : { code: "api_error", message: "internal error" },
        });
        if (persistenceError) {
          expect(warnings).toHaveBeenCalledWith(expect.stringContaining(persistenceError.message));
        }
      }
      expect(agentCommandMock).toHaveBeenCalledTimes(failures.length);
      expect(persistence).toHaveBeenCalledTimes(failures.length);
    } finally {
      persistence.mockRestore();
      warnings.mockRestore();
    }
  });
}
