import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { killProcessTree } from "../../src/process/kill-tree.js";
import { getFileLockProcessStartTime } from "../../src/shared/pid-alive.js";
import { reserveTestPortListener } from "../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesSse, writeOpenAiResponsesText } from "./openai-responses-sse.js";
import { createDeferred } from "./promise.js";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";

export async function startGatewayRestartProvider(signal: AbortSignal) {
  const ready = createDeferred();
  void ready.promise.catch(() => {});
  const held = new Set<number>();
  const issuedExecs = new Set<number>();
  const processes = new Map<number, number>();
  let ordinal = 0;

  async function respond(request: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const body: unknown = JSON.parse(text);
    if (!isRecord(body)) {
      throw new Error("Expected a provider request object");
    }
    ordinal += 1;
    const input = Array.isArray(body.input) ? body.input : [body.input];
    if (request.url === "/v1/embeddings") {
      const dimensions = typeof body.dimensions === "number" ? body.dimensions : 1536;
      const vector = Array.from({ length: dimensions }, (_, index) => Number(index === 0));
      const embedding =
        body.encoding_format === "base64"
          ? Buffer.from(new Float32Array(vector).buffer).toString("base64")
          : vector;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          model: body.model,
          data: input.map((_, index) => ({ object: "embedding", index, embedding })),
          usage: { prompt_tokens: input.length, total_tokens: input.length },
        }),
      );
      return;
    }
    if (request.url !== "/v1/responses") {
      throw new Error(`Unexpected provider route ${request.url}`);
    }
    const executionTool =
      Array.isArray(body.tools) &&
      body.tools.some((tool) => isRecord(tool) && tool.name === "exec");
    if (!executionTool) {
      const reply = "Synthetic restart handoff session";
      if (body.stream === false) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: `resp_title_${ordinal}`,
            object: "response",
            status: "completed",
            output: [
              {
                type: "message",
                id: `msg_title_${ordinal}`,
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: reply, annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
        );
      } else {
        writeOpenAiResponsesText(response, {
          text: reply,
          messageId: `msg_title_${ordinal}`,
          responseId: `resp_title_${ordinal}`,
        });
      }
      return;
    }
    const marker = /RESTART_HANDOFF_([0-5])/.exec(text)?.[1];
    if (marker === undefined) {
      throw new Error("Execution request lost its session marker");
    }
    const index = Number(marker);
    const outputs = input.filter((item) => isRecord(item) && item.type === "function_call_output");
    for (const output of outputs) {
      const pid = /Command still running \(session [^,]+, pid (\d+)\)/.exec(
        JSON.stringify(output),
      )?.[1];
      if (pid) {
        const start = getFileLockProcessStartTime(Number(pid));
        if (start !== null) {
          processes.set(Number(pid), start);
        }
      }
    }
    if (index < 2 && outputs.length === 0 && !issuedExecs.has(index)) {
      issuedExecs.add(index);
      // Replace the shell so the returned PID also owns the long-lived fixture process.
      const args = JSON.stringify({ command: "exec sleep 3600", background: true });
      const item = {
        type: "function_call",
        id: `fc_exec_${index}`,
        call_id: `call_exec_${index}`,
        name: "exec",
        arguments: args,
      };
      writeOpenAiResponsesSse(response, [
        { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: item.id,
          delta: args,
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: `resp_exec_${index}`,
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]);
      return;
    }
    held.add(index);
    if (held.size === 6 && processes.size === 2) {
      ready.resolve();
    }
    // Keep only the six execution calls unanswered; housekeeping must still settle.
  }

  const reservation = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      createServer((request, response) => {
        void respond(request, response).catch((error: unknown) => {
          if (request.aborted) {
            return;
          }
          ready.reject(error);
          response.destroy(error instanceof Error ? error : undefined);
        });
      }),
  });
  return {
    baseUrl: `http://127.0.0.1:${reservation.claim.port}/v1`,
    ready: ready.promise,
    async close() {
      await runQaGatewayFixture(
        async () => {
          for (const [pid, startedAt] of processes) {
            if (getFileLockProcessStartTime(pid) === startedAt) {
              killProcessTree(pid, { force: true });
            }
          }
          reservation.listener.closeAllConnections();
        },
        reservation.releaseListener,
        reservation.claim.release,
      );
    },
  };
}
