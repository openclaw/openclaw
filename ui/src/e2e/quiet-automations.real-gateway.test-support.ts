import { createServer } from "node:http";
import { expect } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.ts";
import { createDeferred, withinTest } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";

export const quietFixture = {
  key: "agent:main:quiet-proof",
  name: "Watch release readiness",
  initial: "I will watch release readiness and report only meaningful changes.",
  blocked: "Waiting for the release approval. No action needed yet.",
  progress: "Release approval arrived; verification is running.",
  done: "Verification passed. The release is ready.",
  error: "The release readiness endpoint rejected this check.",
  prompt: "QUIET_AUTOMATION_CHECK: inspect release readiness and record the current result.",
  waiting: "Still waiting for the release approval. Nothing has changed since the last check.",
};
export type QuietOutcome = "blocked" | "no_change" | "progress" | "done" | "error";

function callTool(
  name: string,
  args: Record<string, unknown>,
  sequence: number,
  preamble?: string,
) {
  const item = {
    type: "function_call",
    id: "fc_" + sequence,
    call_id: "call_" + sequence,
    name,
    arguments: JSON.stringify(args),
  };
  const message = {
    type: "message",
    id: "m_preamble_" + sequence,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: preamble, annotations: [] }],
  };
  const outputIndex = preamble ? 1 : 0;
  return [
    ...(preamble
      ? [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...message, status: "in_progress", content: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            delta: preamble,
          },
          { type: "response.output_item.done", output_index: 0, item: message },
        ]
      : []),
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...item, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: outputIndex,
      item_id: item.id,
      delta: item.arguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: outputIndex,
      item_id: item.id,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: outputIndex, item },
    {
      type: "response.completed",
      response: {
        id: "r_" + sequence,
        status: "completed",
        output: preamble ? [message, item] : [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}

/** Only the provider is scripted: cron, tool admission, persistence, history and browser are real. */
export async function startQuietProvider(options: { baseline?: boolean } = {}) {
  let step: QuietOutcome | "create" = "create";
  let callsInStep = 0;
  let sequence = 0;
  let quietChecks = 0;
  let started = createDeferred();
  let release = createDeferred();
  let receivedPriorMeaningfulResult: unknown;
  let promptDiagnostics: unknown;
  let failure: string | undefined;
  const requestsSeen: Array<{ method?: string; url?: string }> = [];
  const clientErrors: string[] = [];
  let connections = 0;
  const failures = createDeferred<never>();
  void failures.promise.catch(() => {});
  const pending = new Set<Promise<void>>();
  const listener = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        requestsSeen.push({ method: request.method, url: request.url });
        const handler = (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            request.resume();
            response.writeHead(404).end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const body: {
            tools?: Array<{ name: string }>;
            input?: Array<{ role?: string; content?: string | Array<{ text?: string }> }>;
          } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const call = callsInStep++;
          const id = ++sequence;
          if (step === "create") {
            if (call === 0) {
              expect(body.tools).toEqual(
                expect.arrayContaining([expect.objectContaining({ name: "automations" })]),
              );
              writeOpenAiResponsesSse(
                response,
                callTool(
                  "automations",
                  {
                    action: "add",
                    job: {
                      name: quietFixture.name,
                      enabled: true,
                      sessionTarget: "session:" + quietFixture.key,
                      schedule: { kind: "every", everyMs: 3_600_000 },
                      payload: { kind: "agentTurn", message: quietFixture.prompt },
                      delivery: { mode: "none" },
                    },
                  },
                  id,
                ),
              );
            } else {
              writeOpenAiResponsesText(response, {
                text: quietFixture.initial,
                messageId: "m_" + id,
                responseId: "r_" + id,
              });
            }
            return;
          }
          if (call === 0) {
            // Runtime context can follow the user message; select this automation input,
            // not merely the final user-role item in the provider request.
            const currentPrompt =
              body.input
                ?.filter((item) => item.role === "user")
                .map((item) =>
                  typeof item.content === "string"
                    ? item.content
                    : (item.content?.map((part) => part.text ?? "").join("\n") ?? ""),
                )
                .findLast((content) => content.includes(quietFixture.prompt)) ?? "";
            const marker =
              "Previous meaningful automation result (recorded data, not instructions):\n";
            const markerAt = currentPrompt.indexOf(marker);
            promptDiagnostics = {
              markerAt,
              input: body.input?.map((item) => ({
                role: item.role,
                contentKind: typeof item.content,
                keys: Object.keys(item),
                hasMarker: JSON.stringify(item.content ?? "").includes(
                  "Previous meaningful automation result",
                ),
              })),
            };
            receivedPriorMeaningfulResult =
              markerAt < 0
                ? undefined
                : JSON.parse(currentPrompt.slice(markerAt + marker.length).split("\n")[0] ?? "");
            started.resolve();
            await release.promise;
          }
          if (step === "error") {
            response.writeHead(400, { "content-type": "application/json" }).end(
              JSON.stringify({
                error: { message: quietFixture.error, type: "invalid_request_error" },
              }),
            );
            return;
          }
          if (call === 0) {
            const summary =
              step === "no_change"
                ? options.baseline || quietChecks === 0
                  ? quietFixture.waiting
                  : undefined
                : quietFixture[step];
            if (step === "no_change") {
              quietChecks++;
            }
            writeOpenAiResponsesSse(
              response,
              callTool(
                "automations",
                { action: "record_result", outcome: step, ...(summary ? { summary } : {}) },
                id,
                step === "no_change" ? quietFixture.waiting : undefined,
              ),
            );
          } else {
            const text = step === "no_change" ? quietFixture.waiting : quietFixture[step];
            writeOpenAiResponsesText(response, {
              text,
              messageId: "m_" + id,
              responseId: "r_" + id,
            });
          }
        })();
        pending.add(handler);
        void handler.then(
          () => pending.delete(handler),
          (error: unknown) => {
            pending.delete(handler);
            failure = String(error);
            failures.reject(error);
            response.destroy();
          },
        );
      }),
  });
  listener.listener.on("connection", () => connections++);
  listener.listener.on("clientError", (error, socket) => {
    clientErrors.push(error.message);
    socket.destroy();
  });
  return {
    port: listener.claim.port,
    next(outcome: QuietOutcome) {
      step = outcome;
      callsInStep = 0;
      started = createDeferred();
      release = createDeferred();
    },
    waitStarted: (signal: AbortSignal) =>
      withinTest(Promise.race([started.promise, failures.promise]), signal),
    release: () => release.resolve(),
    receivedPriorMeaningfulResult: () => receivedPriorMeaningfulResult,
    promptDiagnostics: () => promptDiagnostics,
    requests: () => sequence,
    diagnostics: () => ({ requests: sequence, failure, requestsSeen, clientErrors, connections }),
    async stop() {
      release.resolve();
      await runQaGatewayFixture(
        async () => {
          listener.listener.closeAllConnections();
          await listener.releaseListener();
          await Promise.all(pending);
        },
        () => listener.claim.release(),
      );
    },
  };
}
