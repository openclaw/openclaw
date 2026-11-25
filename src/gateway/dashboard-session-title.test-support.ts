import { text as readText } from "node:stream/consumers";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
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
  raw: string | (() => string),
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
  const ollama = api === "ollama";
  const fixtureProvider = ollama ? "ollama" : provider;
  const fixtureModel = ollama ? "qwen3.6:35b" : model;
  const fixtureModelRef = `${fixtureProvider}/${fixtureModel}`;
  await withOpenClawTestState({ label: "title-transport" }, async (state) => {
    const storePath = state.statePath("sessions.json");
    const requests: TitleRequest[] = [];
    await withServer(
      (request, response) => {
        void readText(request).then((body) => {
          requests.push({
            authorization: request.headers.authorization,
            url: request.url,
            body: JSON.parse(body),
          });
          const content = typeof raw === "function" ? raw() : raw;
          const message = { role: "assistant", content };
          const data = JSON.stringify(
            ollama
              ? { model: fixtureModel, message, done: true, done_reason: "stop" }
              : {
                  id: "chatcmpl-title-proof",
                  object: "chat.completion.chunk",
                  created: 0,
                  model,
                  choices: [{ index: 0, delta: message, finish_reason: "stop" }],
                  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                },
          );
          response.writeHead(200, {
            "content-type": ollama ? "application/x-ndjson" : "text/event-stream",
          });
          response.end(ollama ? `${data}\n` : `data: ${data}\n\ndata: [DONE]\n\n`);
        });
      },
      async (baseUrl) => {
        const cfg: OpenClawConfig = {
          session: { store: storePath },
          plugins: ollama ? { allow: ["ollama"] } : { enabled: false },
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
                baseUrl: ollama ? baseUrl : baseUrl + "/v1",
                apiKey: "test-key",
                api,
                agentRuntime: { id: "openclaw" },
                request: { allowPrivateNetwork: true },
                models: [primaryModel, fixtureModel].map((id) =>
                  modelDefinition(id, { api, reasoning: false, contextWindow: 16_000 }),
                ),
              },
            },
          },
        };
        setRuntimeConfigSnapshot(cfg);
        await run({
          cfg,
          agentDir: state.agentDir(),
          storePath,
          workspaceDir: state.workspaceDir,
          requests,
          env: state.envVars,
        });
      },
    );
  });
}
