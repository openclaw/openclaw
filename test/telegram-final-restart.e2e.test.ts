import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import {
  listenLoopback,
  closeHttpServer,
  respondJson,
} from "./helpers/gateway-integration-fixtures.js";
import { createOpenAiResponsesModelConfig } from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { readBody } from "./telegram-http.test-support.js";

it(
  "notifies the original Telegram chat after crashing during an affirmed flood wait",
  { timeout: 180_000 },
  async ({ signal }) => {
    const answer = "RESTART_FINAL_141959";
    let modelRequests = 0;
    let flooded = true;
    const attempts: string[] = [];
    const delivered: string[] = [];
    let inboundReady = false;
    let inboundSent = false;
    const provider = createServer((request, response) => {
      readBody(request, () => {
        modelRequests++;
        writeOpenAiResponsesText(response, {
          text: answer,
          messageId: "msg_restart",
          responseId: "resp_restart",
        });
      });
    });
    const botApi = createServer((request, response) => {
      readBody(request, (body) => {
        const payload = body ? JSON.parse(body) : {};
        const method = request.url?.split("/").at(-1);
        if (method === "getMe") {
          respondJson(response, {
            ok: true,
            result: {
              id: 141959,
              is_bot: true,
              first_name: "Fixture",
              username: "RestartFixtureBot",
            },
          });
        } else if (method === "getUpdates") {
          const result =
            inboundReady && !inboundSent
              ? [
                  {
                    update_id: 141959,
                    message: {
                      message_id: 10,
                      date: Math.floor(Date.now() / 1000),
                      chat: { id: 123, type: "private", first_name: "Fixture" },
                      from: { id: 123, is_bot: false, first_name: "Fixture" },
                      text: "Return the requested answer.",
                    },
                  },
                ]
              : [];
          if (result.length) {
            inboundSent = true;
          }
          setTimeout(() => respondJson(response, { ok: true, result }), 100);
        } else if (method === "sendMessage" || method === "sendRichMessage") {
          const text = payload.text ?? "";
          attempts.push(text);
          if (flooded) {
            respondJson(
              response,
              {
                ok: false,
                error_code: 429,
                description: "Too Many Requests: retry after 30",
                parameters: { retry_after: 30 },
              },
              429,
            );
          } else {
            delivered.push(text);
            respondJson(response, {
              ok: true,
              result: {
                message_id: 100 + delivered.length,
                date: 1,
                chat: { id: 123, type: "private" },
                text,
              },
            });
          }
        } else {
          respondJson(response, { ok: true, result: true });
        }
      });
    });
    const providerUrl = await listenLoopback(provider);
    const apiRoot = await listenLoopback(botApi);
    const model = createOpenAiResponsesModelConfig({
      baseUrl: providerUrl,
      providerId: "fixture",
      modelId: "restart-fixture",
      reasoning: false,
      toolProfile: "minimal",
    });
    const instance = await createOpenClawTestInstance({
      name: "telegram-final-restart",
      signal,
      startTimeoutMs: 90_000,
      env: {
        OPENCLAW_SKIP_CHANNELS: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
      config: {
        ...model,
        update: { checkOnStart: false },
        browser: { enabled: false },
        discovery: { mdns: { mode: "off" } },
        channels: {
          telegram: {
            enabled: true,
            accounts: {
              default: {
                botToken: "141959:synthetic-restart-fixture",
                apiRoot,
                dmPolicy: "allowlist",
                allowFrom: ["123"],
                streaming: { mode: "off" },
              },
            },
          },
        },
        plugins: { ...model.plugins, entries: { telegram: { enabled: true } } },
        agents: {
          defaults: { model: model.agents?.defaults?.model, skipBootstrap: true, skills: [] },
        },
        models: {
          ...model.models,
          providers: {
            fixture: { ...model.models?.providers?.fixture, agentRuntime: { id: "openclaw" } },
          },
        },
      },
    });
    try {
      await instance.startGateway();
      const firstPid = instance.child?.pid;
      inboundReady = true;
      await vi.waitFor(
        () => {
          expect(attempts).toContain(answer);
          expect(instance.logs()).toContain("flood control on sendMessage");
        },
        { timeout: 45_000 },
      );
      expect(modelRequests).toBe(1);
      await instance.crashGateway();
      await instance.stopGateway();
      flooded = false;
      await instance.startGateway();
      expect(instance.child?.pid).not.toBe(firstPid);
      await vi.waitFor(() => expect(instance.logs()).toContain("refusing blind replay"), {
        timeout: 75_000,
      });
      await vi.waitFor(
        () =>
          expect(
            delivered.some((text) => text.includes("I couldn’t confirm whether my previous reply")),
          ).toBe(true),
        { timeout: 10_000 },
      );
      expect(attempts.filter((text) => text === answer)).toHaveLength(1);
      expect(
        delivered.filter((text) => text.includes("I couldn’t confirm whether my previous reply")),
      ).toHaveLength(1);
      console.log(
        JSON.stringify({
          firstPid,
          restartedPid: instance.child?.pid,
          modelRequests,
          answerAttempts: attempts.filter((text) => text === answer).length,
          delivered,
        }),
      );
    } catch (error) {
      throw new Error(String(error) + "\n" + instance.logs(), { cause: error });
    } finally {
      await instance.cleanup();
      await closeHttpServer(botApi);
      await closeHttpServer(provider);
    }
  },
);
