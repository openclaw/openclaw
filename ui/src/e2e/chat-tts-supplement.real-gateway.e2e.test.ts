import { writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { accessibleChatComposer, fillComposer } from "../test-helpers/composer-editor.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:speech-supplement";
const replies = [
  "The first spoken answer stays visible.",
  "The second spoken answer stays visible.",
  "This answer has no speech attachment.",
] as const;
type ProviderRequest = {
  model: string;
};
type HistoryFrame = {
  type: string;
  id?: string;
  method?: string;
  payload?: { deltaCursor?: string; messages?: unknown[] };
};

function speechWav() {
  const samples = 1_600;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    wav.writeInt16LE(
      Math.round(Math.sin((index * 2 * Math.PI * 440) / 16_000) * 4_000),
      44 + index * 2,
    );
  }
  return wav;
}

async function startProvider() {
  const speech: ServerResponse[] = [];
  const receipts: Array<{
    method?: string;
    path: string;
    model?: string;
    promptIndex?: number;
    status?: number;
  }> = [];
  let turns = 0;
  let requests = 0;
  const server = createServer((request, response) => {
    const receipt: (typeof receipts)[number] = {
      method: request.method,
      path: request.url?.split("?")[0] ?? "",
    };
    receipts.push(receipt);
    if (request.method === "GET" && request.url === "/speech") {
      request.resume();
      speech.push(response);
    } else if (request.method === "POST" && request.url === "/v1/responses") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const input: ProviderRequest = JSON.parse(body);
        receipt.model = input.model;
        const index = input.model === "echo" ? turns++ : -1;
        const text = input.model === "metadata" ? "Speech fixture" : replies[index];
        receipt.promptIndex = index;
        if (text === undefined) {
          receipt.status = 400;
          response.writeHead(400).end("Unexpected model turn");
          return;
        }
        requests += 1;
        receipt.status = 200;
        writeOpenAiResponsesText(response, {
          text,
          messageId: `speech-answer-${requests}`,
          responseId: `speech-response-${requests}`,
        });
      });
    } else {
      request.resume();
      receipt.status = 404;
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Speech fixture did not bind a TCP port");
  }
  return {
    port: address.port,
    receipts,
    speech,
    turns: () => turns,
    release(index: number) {
      const response = speech[index];
      if (!response) {
        throw new Error("Speech synthesis has not reached its gate");
      }
      response.writeHead(200, { "content-type": "audio/wav" }).end(speechWav());
    },
    async close() {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await closed;
    },
  };
}

let instance: OpenClawTestInstance;
let provider: Awaited<ReturnType<typeof startProvider>>;
const suite = createControlUiE2eSuite({
  name: "Speech supplements through real chat.send and cursor history",
  startServerBeforeBrowser: true,
  async startServer() {
    provider = await startProvider();
    try {
      instance = await createOpenClawTestInstance({
        name: "speech-supplement",
        env: {
          HOME: process.env.HOME,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          VITEST: undefined,
        },
        config: {
          gateway: { controlUi: { enabled: true } },
          cron: { enabled: false },
          browser: { enabled: false },
          agents: {
            ownership: "explicit",
            defaults: {
              model: "speech-fixture/echo",
              utilityModel: "speech-fixture/metadata",
              models: {
                "speech-fixture/echo": { params: { transport: "sse" } },
                "speech-fixture/metadata": { params: { transport: "sse" } },
              },
              modelPolicy: { allow: ["speech-fixture/*"] },
            },
            entries: { main: { identity: { name: "Speech fixture" } } },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "speech-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-unused-key",
                baseUrl: `http://127.0.0.1:${provider.port}/v1`,
                request: { allowPrivateNetwork: true },
                models: [
                  { id: "echo", name: "Echo" },
                  { id: "metadata", name: "Metadata" },
                ],
              },
            },
          },
          plugins: { allow: ["openai", "tts-local-cli"] },
          tts: {
            auto: "off",
            mode: "final",
            provider: "tts-local-cli",
            providers: {
              "tts-local-cli": {
                command: process.execPath,
                args: [
                  "--input-type=module",
                  "--eval",
                  'import { writeFile } from "node:fs/promises"; process.stdin.resume(); const response = await fetch(process.argv[2]); if (!response.ok) throw new Error("Speech fixture failed"); await writeFile(process.argv[1], Buffer.from(await response.arrayBuffer()));',
                  "{{OutputPath}}",
                  `http://127.0.0.1:${provider.port}/speech`,
                ],
                outputFormat: "wav",
                timeoutMs: 60_000,
              },
            },
          },
        },
      });
      expect(instance.env.OPENCLAW_HOME).toBe(instance.homeDir);
      expect(instance.env.OPENCLAW_STATE_DIR).toBe(instance.stateDir);
      expect(instance.env.OPENCLAW_CONFIG_PATH).toBe(instance.configPath);
      expect(instance.env.HOME).toBe(process.env.HOME);
      await instance.startGateway();
      return {
        baseUrl: `http://127.0.0.1:${instance.port}/`,
        async close() {
          try {
            await instance.cleanup();
          } finally {
            await provider.close();
          }
        },
      };
    } catch (error) {
      try {
        await instance?.cleanup();
      } finally {
        await provider.close();
      }
      throw error;
    }
  },
});

suite.define(() => {
  it("attaches delayed speech to each original answer live and after reload", async (context) => {
    try {
      await suite.runScenario(context, {
        retainedState: () => instance.stateDir,
        run: async () => {
          const created = await instance.cli([
            "gateway",
            "call",
            "sessions.create",
            "--json",
            "--params",
            JSON.stringify({ key: sessionKey, agentId: "main", label: "Speech supplements" }),
          ]);
          expect(created.code, created.stderr).toBe(0);
          const dashboard = await instance.cli(["dashboard", "--json"]);
          expect(dashboard.code, dashboard.stderr).toBe(0);
          const { browserUrl }: { browserUrl: string } = JSON.parse(dashboard.stdout);
          const url = new URL(browserUrl);
          url.pathname = "/chat/main/speech-supplement";
          await suite.withPage(
            { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
            async ({ page }) => {
              const historyRequests = new Set<string>();
              const history: HistoryFrame[] = [];
              page.on("websocket", (socket) => {
                socket.on("framesent", ({ payload }) => {
                  const frame: HistoryFrame = JSON.parse(payload.toString());
                  if (frame.id && ["chat.history", "chat.startup"].includes(frame.method ?? "")) {
                    historyRequests.add(frame.id);
                  }
                });
                socket.on("framereceived", ({ payload }) => {
                  const frame: HistoryFrame = JSON.parse(payload.toString());
                  if (frame.id && historyRequests.has(frame.id) && frame.payload?.deltaCursor) {
                    history.push(frame);
                  }
                });
              });
              await page.addInitScript(() => {
                localStorage.setItem(
                  "openclaw:control-ui:community-invite",
                  JSON.stringify({ dismissedAtMs: 1770000000000 }),
                );
              });
              await page.goto(url.href);
              await waitForControlUiGatewayReady(page);
              const composer = accessibleChatComposer(page);
              const send = async (text: string) => {
                await fillComposer(composer, text);
                await page.getByRole("button", { name: "Send message", exact: true }).click();
              };
              const answer = (text: string) =>
                page.locator(".chat-bubble").filter({ hasText: text });
              const assertSpeech = async (text: string, total: number) => {
                const bubble = answer(text);
                await expect.poll(() => bubble.count()).toBe(1);
                await expect.poll(() => bubble.locator("audio").count()).toBe(1);
                const audio = bubble.locator("audio");
                await audio.evaluate((element) => {
                  if (!(element instanceof HTMLAudioElement)) {
                    throw new Error("Expected audio");
                  }
                  element.load();
                });
                await expect
                  .poll(() =>
                    audio.evaluate(
                      (element) =>
                        element instanceof HTMLAudioElement &&
                        element.readyState >= 2 &&
                        element.duration > 0,
                    ),
                  )
                  .toBe(true);
                await audio.evaluate(async (element) => {
                  if (!(element instanceof HTMLAudioElement)) {
                    throw new Error("Expected audio");
                  }
                  await element.play();
                  element.pause();
                });
                expect(await page.locator(".chat-bubble audio").count()).toBe(total);
                expect(
                  await page
                    .locator(".chat-bubble")
                    .getByText("Audio reply", { exact: true })
                    .count(),
                ).toBe(0);
              };
              await send("/tts chat on");
              await page.locator(".chat-bubble").getByText("TTS enabled for this chat.").waitFor();
              for (const [index, text] of replies.slice(0, 2).entries()) {
                await send(`Please give spoken answer ${index + 1}.`);
                await answer(text).waitFor();
                await expect.poll(() => provider.speech.length).toBe(index + 1);
                // Keep synthesis pending until the browser has accepted the answer's history cursor.
                await expect
                  .poll(() =>
                    history.some((frame) =>
                      JSON.stringify(frame.payload?.messages ?? []).includes(text),
                    ),
                  )
                  .toBe(true);
                provider.release(index);
                await assertSpeech(text, index + 1);
                await page
                  .getByRole("button", { name: "Stop generating", exact: true })
                  .waitFor({ state: "detached" });
                await page.reload();
                await waitForControlUiGatewayReady(page);
                await assertSpeech(text, index + 1);
              }
              await send("/tts chat off");
              await page.locator(".chat-bubble").getByText("TTS disabled for this chat.").waitFor();
              await send("Please give a text-only answer.");
              await answer(replies[2]).waitFor();
              await page
                .getByRole("button", { name: "Stop generating", exact: true })
                .waitFor({ state: "detached" });
              expect(await answer(replies[2]).locator("audio").count()).toBe(0);
              expect(await page.locator(".chat-bubble audio").count()).toBe(2);
              expect(provider.speech).toHaveLength(2);
              expect(provider.turns()).toBe(3);
            },
          );
        },
      });
    } catch (error) {
      let gatewayLog = instance.logs();
      for (const value of [
        instance.gatewayToken,
        instance.hookToken,
        instance.stateDir,
        instance.homeDir,
        process.cwd(),
        hostname(),
      ]) {
        gatewayLog = gatewayLog.split(value).join("<fixture>");
      }
      if (process.env.HOME) {
        gatewayLog = gatewayLog.split(process.env.HOME).join("<home>");
      }
      await writeFile(
        path.join(suite.artifactDir, "speech-fixture.failure.json"),
        JSON.stringify(
          {
            provider: provider.receipts,
            speechRequests: provider.speech.length,
            primaryTurns: provider.turns(),
            gatewayLog,
          },
          null,
          2,
        ) + "\n",
      );
      throw error;
    }
  }, 180_000);
});
