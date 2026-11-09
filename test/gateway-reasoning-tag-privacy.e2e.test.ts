// Offline public Gateway proof with an isolated streaming model fixture.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { createOpenAiResponsesModelConfig } from "./helpers/openai-responses-model-fixture.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

it(
  "withholds nested and split attributed tags on the public Gateway stream before provider completion",
  { timeout: 180_000 },
  async ({ signal }) => {
    const modelId = "r0324-stream";
    const sessionKey = "agent:main:r0324-stream";
    const runId = randomUUID();
    const prefixSeen = createDeferred();
    const answerSeen = createDeferred();
    const releaseBody = createDeferred();
    const releaseEnd = createDeferred();
    const fixtureFailure = createDeferred<never>();
    void fixtureFailure.promise.catch(() => {});
    const observed: Array<{ stream: string; text: string; delta: string }> = [];
    let ended = false;
    let requests = 0;
    let providerStage = "not-requested";
    let accepted = false;
    let eventsSeen = 0;
    let matchingAgentEvents = 0;
    let lifecyclePhase: unknown;
    let publicText = "";
    let publicItemId: string | undefined;
    const reservation = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () =>
        createServer((request, response) => {
          void (async () => {
            if (request.method === "GET" && request.url === "/v1/models") {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ data: [{ id: modelId, object: "model" }] }));
              return;
            }
            if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
              throw new Error("Unexpected model fixture route: " + request.url);
            }
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(Buffer.from(chunk));
            }
            const body = asOptionalRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            if (body?.stream !== true || body.model !== modelId) {
              throw new Error("Expected the configured streaming model request");
            }
            requests += 1;
            providerStage = "request-received";
            if (requests !== 1) {
              throw new Error("Unexpected model retry/housekeeping request");
            }
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
            });
            const send = (delta: Record<string, unknown>, finish: string | null = null) => {
              response.write(
                "data: " +
                  JSON.stringify({
                    id: "chatcmpl-r0324",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: modelId,
                    choices: [{ index: 0, delta, finish_reason: finish }],
                  }) +
                  "\n\n",
              );
            };
            send({ role: "assistant", content: "Before " });
            providerStage = "prefix-sent";
            await withinTest(releaseBody.promise, signal);
            for (const content of [
              "<think>outer<think>inner</think>",
              "PRIVATE_MARKER",
              "</think> After\n",
              "Canon <",
              "reasoning>PRIVATE_MARKER</reasoning> Done\n",
              "Attr <internal note='a>",
              "b'>PRIVATE_MARKER</internal> PUBLIC_DONE",
              // A blank block boundary makes Markdown ownership stable while SSE stays open.
              "\n\n",
            ]) {
              send({ content });
            }
            providerStage = "body-sent";
            // The test must observe public output while the provider response is still open.
            await withinTest(releaseEnd.promise, signal);
            providerStage = "end-released";
            ended = true;
            send({}, "stop");
            response.end("data: [DONE]\n\n");
          })().catch((error: unknown) => {
            fixtureFailure.reject(error);
            response.destroy(error instanceof Error ? error : undefined);
          });
        }),
    });
    let instance: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
    let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    let turn: Promise<unknown> | undefined;
    try {
      // Reuse the existing isolated model configuration, selecting its supported
      // unphased completions transport so Responses phase buffering cannot mask this bug.
      const config = createOpenAiResponsesModelConfig({
        baseUrl: "http://127.0.0.1:" + reservation.claim.port,
        providerId: modelId,
        modelId,
        reasoning: true,
        toolProfile: "minimal",
      });
      const provider = config.models?.providers?.[modelId];
      if (!provider) {
        throw new Error("Missing fixture provider");
      }
      provider.api = "openai-completions";
      for (const model of provider.models) {
        model.api = "openai-completions";
      }
      instance = await createOpenClawTestInstance({
        name: "r0324-stream",
        config,
        signal,
        env: {
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_AGENT_RUNTIME: undefined,
        },
      });
      await instance.startGateway();
      client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        signal,
        deviceIdentity: loadOrCreateDeviceIdentity({ path: instance.state.path("client.sqlite") }),
        onEvent: (event) => {
          eventsSeen += 1;
          const payload = asOptionalRecord(event.payload);
          if (event.event !== "agent" || payload?.runId !== runId) {
            return;
          }
          matchingAgentEvents += 1;
          const data = asOptionalRecord(payload.data);
          if (payload.stream === "lifecycle") {
            lifecyclePhase = data?.phase;
          }
          if (!data || typeof payload.stream !== "string") {
            return;
          }
          if (!["assistant", "thinking", "item"].includes(payload.stream)) {
            return;
          }
          const text =
            typeof data.text === "string"
              ? data.text
              : typeof data.progressText === "string"
                ? data.progressText
                : "";
          const delta = typeof data.delta === "string" ? data.delta : "";
          observed.push({ stream: payload.stream, text, delta });
          if (payload.stream === "assistant") {
            // The first/recovery frame is a snapshot; ordinary wire appends omit text.
            // Preserve raw frames above for privacy assertions, and apply the public
            // snapshot/delta contract only to the checkpoint's displayed answer.
            const itemId = typeof data.itemId === "string" ? data.itemId : undefined;
            publicText =
              typeof data.text === "string"
                ? data.text
                : (data.replace === true || itemId !== publicItemId ? "" : publicText) + delta;
            publicItemId = itemId;
            if (publicText === "Before") {
              prefixSeen.resolve();
            }
            if (publicText.includes("PUBLIC_DONE")) {
              answerSeen.resolve();
            }
          }
        },
      });
      await client.request("sessions.subscribe", {});
      await client.request("sessions.create", { key: sessionKey, agentId: "main" });
      await client.request("sessions.messages.subscribe", {
        key: sessionKey,
        subscriptionId: "r0324",
      });
      const operation = client.request(
        "agent",
        {
          sessionKey,
          message: "Reply with the synthetic stream fixture.",
          channel: "webchat",
          deliver: false,
          idempotencyKey: runId,
        },
        {
          expectFinal: true,
          timeoutMs: 120_000,
          onAccepted: () => {
            accepted = true;
          },
        },
      );
      turn = operation;
      void operation.catch(() => {});
      const waitForPublic = async (checkpoint: string, gate: PromiseLike<void>) => {
        try {
          await withinTest(
            Promise.race([
              awaitGateBeforeSettlement(
                gate,
                operation,
                "Provider turn ended before public stream checkpoint",
              ),
              fixtureFailure.promise,
            ]),
            signal,
          );
        } catch (cause) {
          // Synthetic fixture data only; no request headers, credentials, or model prompt.
          throw new Error(
            checkpoint +
              ": " +
              JSON.stringify({
                accepted,
                requests,
                providerStage,
                ended,
                eventsSeen,
                matchingAgentEvents,
                lifecyclePhase,
                publicText,
                observed: observed.slice(-8),
              }),
            { cause },
          );
        }
      };
      await waitForPublic("public-prefix", prefixSeen.promise);
      releaseBody.resolve();
      await waitForPublic("public-answer", answerSeen.promise);
      expect(ended).toBe(false);
      const checkPublicContent = () => {
        expect(observed.length).toBeGreaterThan(0);
        for (const event of observed) {
          expect(event.text).not.toContain("PRIVATE_MARKER");
          expect(event.delta).not.toContain("PRIVATE_MARKER");
          expect(event.text).not.toContain("<");
          expect(event.delta).not.toContain("<");
        }
      };
      checkPublicContent();
      expect(publicText).toBe("Before  After\nCanon  Done\nAttr  PUBLIC_DONE");
      releaseEnd.resolve();
      expect(await turn).toMatchObject({ status: "ok", runId });
      checkPublicContent();
      expect(requests).toBe(1);
    } finally {
      releaseBody.resolve();
      releaseEnd.resolve();
      await runQaGatewayFixture(
        async () => {},
        async () => {
          if (client) {
            await disconnectGatewayClient(client);
          }
        },
        async () => {
          await instance?.cleanup();
        },
        async () => {
          reservation.listener.closeAllConnections();
          await reservation.releaseListener();
        },
        reservation.claim.release,
      );
      if (turn) {
        await Promise.allSettled([turn]);
      }
    }
  },
);
