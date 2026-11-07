import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { writeOpenAiResponsesText } from "../../../helpers/openai-responses-sse.js";

export const SLACK_INFLIGHT_MODEL = "mock-openai/gpt-5.6-luna";
export const SLACK_INFLIGHT_ROOT_REPLY = "SLACK_INFLIGHT_ROOT_DONE";
export const SLACK_INFLIGHT_FOLLOWUP_REPLY = "SLACK_INFLIGHT_FOLLOWUP_DONE";
export const SLACK_INFLIGHT_ROOT_TEXT =
  "Reply with only this exact marker: SLACK_INFLIGHT_ROOT_DONE";
export const SLACK_INFLIGHT_FOLLOWUP_TEXT =
  "Use the revised total. Reply with only this exact marker: SLACK_INFLIGHT_FOLLOWUP_DONE";

export async function waitForSlackGatewayFact<T>(
  read: () => Promise<T | undefined> | T | undefined,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Only the external model HTTP boundary is simulated. The shared Responses
// writer supplies the same wire protocol used by other actual-Gateway tests.
export async function startHeldSlackModelProvider() {
  let release!: () => void;
  const rootGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let released = false;
  let rootClosed = false;
  const requests: Array<{ input: string; model: unknown; root: boolean; followup: boolean }> = [];
  const active = new Set<Promise<void>>();
  const errors: string[] = [];
  const server = createServer((request, response) => {
    const work = (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] }));
        return;
      }
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/responses");
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        assert.ok(bytes <= 16 * 1024 * 1024, "Provider request exceeded fixture bound");
        chunks.push(buffer);
      }
      const body = asNonArrayRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const input = JSON.stringify(body.input);
      const entry = {
        input,
        model: body.model,
        root: input.includes(SLACK_INFLIGHT_ROOT_TEXT),
        followup: input.includes(SLACK_INFLIGHT_FOLLOWUP_TEXT),
      };
      requests.push(entry);
      assert.ok(requests.length <= 10, "Unexpected model retry loop");
      assert.ok(entry.root || entry.followup, "Unexpected fixture model request");
      if (requests.length === 1) {
        assert.ok(entry.root && !entry.followup, "Root must reach the model first");
        response.once("close", () => {
          rootClosed = true;
        });
        await rootGate;
      }
      if (response.destroyed) {
        return;
      }
      writeOpenAiResponsesText(response, {
        text: entry.followup ? SLACK_INFLIGHT_FOLLOWUP_REPLY : SLACK_INFLIGHT_ROOT_REPLY,
        messageId: `msg_${randomUUID()}`,
        responseId: `resp_${randomUUID()}`,
      });
    })().catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
    active.add(work);
    void work.finally(() => active.delete(work));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    errors,
    get rootHeld() {
      return requests.length > 0 && !released && !rootClosed;
    },
    releaseRoot() {
      released = true;
      release();
    },
    async stop() {
      released = true;
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      await Promise.all(active);
    },
  };
}
