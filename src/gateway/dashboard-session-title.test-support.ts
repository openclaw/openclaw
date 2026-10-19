import { text as readText } from "node:stream/consumers";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

export const provider = "title-proof";
export const model = "title-model";
const primaryModel = "primary-title-model";
export const modelRef = `${provider}/${model}`;
type TitleRequest = {
  authorization: string | undefined;
  url: string | undefined;
  body: Record<string, unknown>;
};

export async function withTitleProvider(
  raw: string,
  run: (fixture: {
    cfg: OpenClawConfig;
    agentDir: string;
    storePath: string;
    workspaceDir: string;
    requests: TitleRequest[];
    env: NodeJS.ProcessEnv;
  }) => Promise<void>,
  params?: Record<string, unknown>,
  defaultParams?: Record<string, unknown>,
  api: "openai-completions" | "ollama" = "openai-completions",
) {
  await withOpenClawTestState({ label: "title-transport" }, async (state) => {
    const requests: TitleRequest[] = [];
    await withServer(
      (request, response) => {
        void readText(request).then((body) => {
          requests.push({
            authorization: request.headers.authorization,
            url: request.url,
            body: JSON.parse(body),
          });
          if (api === "ollama") {
            response.writeHead(200, { "content-type": "application/x-ndjson" });
            response.end(
              JSON.stringify({
                model: "qwen3.6:35b",
                message: { role: "assistant", content: raw },
                done: true,
                done_reason: "stop",
              }) + "\n",
            );
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({
              id: "chatcmpl-title-proof",
              object: "chat.completion.chunk",
              created: 0,
              model,
              choices: [
                { index: 0, delta: { role: "assistant", content: raw }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })}\n\ndata: [DONE]\n\n`,
          );
        });
      },
      async (baseUrl) => {
        const fixtureProvider = api === "ollama" ? "ollama" : provider;
        const fixtureModel = api === "ollama" ? "qwen3.6:35b" : model;
        const fixtureModelRef = fixtureProvider + "/" + fixtureModel;
        const cfg: OpenClawConfig = {
          plugins: api === "ollama" ? { allow: ["ollama"] } : { enabled: false },
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: fixtureProvider + "/" + primaryModel },
              utilityModel: fixtureModelRef,
              ...(params ? { models: { [fixtureModelRef]: { params } } } : {}),
              ...(defaultParams ? { params: defaultParams } : {}),
            },
          },
          models: {
            mode: "replace",
            providers: {
              [fixtureProvider]: {
                baseUrl: api === "ollama" ? baseUrl : baseUrl + "/v1",
                apiKey: "test-key",
                api,
                agentRuntime: { id: "openclaw" },
                request: { allowPrivateNetwork: true },
                models: [primaryModel, fixtureModel].map((id): ModelDefinitionConfig => ({
                  id,
                  name: id,
                  api,
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 16_000,
                  maxTokens: 8_192,
                })),
              },
            },
          },
        };
        setRuntimeConfigSnapshot(cfg);
        await run({
          cfg,
          agentDir: state.agentDir(),
          storePath: state.statePath("sessions.json"),
          workspaceDir: state.workspaceDir,
          requests,
          env: state.envVars,
        });
      },
    );
  });
}
