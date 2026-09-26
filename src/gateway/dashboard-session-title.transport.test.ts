import { text as readText } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { runIsolatedCompletion } from "../agents/isolated-completion.js";
import { generateConversationLabel } from "../auto-reply/reply/conversation-label-generator.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  maybeGenerateDashboardSessionTitle,
  prepareDashboardSessionTitle,
} from "./dashboard-session-title.js";
import { deriveSessionTitle } from "./session-utils-core.js";

const provider = "title-proof";
const model = "title-model";
const primaryModel = "primary-title-model";
const modelRef = `${provider}/${model}`;
type TitleRequest = {
  authorization: string | undefined;
  url: string | undefined;
  body: Record<string, unknown>;
};

async function withTitleProvider(
  raw: string,
  run: (fixture: {
    cfg: OpenClawConfig;
    agentDir: string;
    storePath: string;
    requests: TitleRequest[];
  }) => Promise<void>,
  params?: Record<string, unknown>,
  defaultParams?: Record<string, unknown>,
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
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: `${provider}/${primaryModel}` },
              utilityModel: modelRef,
              ...(params ? { models: { [modelRef]: { params } } } : {}),
              ...(defaultParams ? { params: defaultParams } : {}),
            },
          },
          models: {
            mode: "replace",
            providers: {
              [provider]: {
                baseUrl: `${baseUrl}/v1`,
                apiKey: "test-key",
                api: "openai-completions",
                agentRuntime: { id: "openclaw" },
                request: { allowPrivateNetwork: true },
                models: [primaryModel, model].map((id): ModelDefinitionConfig => ({
                  id,
                  name: id,
                  api: "openai-completions",
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
        await run({
          cfg,
          agentDir: state.agentDir(),
          storePath: state.statePath("sessions.json"),
          requests,
        });
      },
    );
  });
}

describe("generated titles over the real OpenAI-compatible transport", () => {
  it.each([
    {
      name: "model aliases overriding global defaults",
      params: {
        chatTemplateKwargs: { enable_thinking: false, configured_only: true },
        extraBody: { min_p: 0.2, store: false },
      },
      defaultParams: {
        chat_template_kwargs: { enable_thinking: true, default_only: true },
        extra_body: { min_p: 0.9, store: true },
      },
      expectedTemplate: { enable_thinking: false, configured_only: true },
    },
    {
      name: "extra-body precedence",
      params: {
        chat_template_kwargs: { enable_thinking: false, configured_only: true },
        extra_body: {
          chat_template_kwargs: { enable_thinking: true, extra_body_only: true },
          min_p: 0.2,
          store: false,
        },
      },
      expectedTemplate: { enable_thinking: true, extra_body_only: true },
    },
  ])(
    "preserves $name through registered utility completion transport",
    async ({ params, defaultParams, expectedTemplate }) => {
      await withTitleProvider(
        "Utility payload verified",
        async ({ cfg, requests }) => {
          await expect(
            prepareDashboardSessionTitle({
              cfg,
              agentId: "main",
              userMessage: "Compare the configured utility payload.",
            }),
          ).resolves.toBe("Utility payload verified");
          expect(requests).toHaveLength(1);
          const body = requests[0]!.body;
          expect(body).toMatchObject({ model, stream: true, min_p: 0.2 });
          expect(body.chat_template_kwargs).toEqual(expectedTemplate);
          expect(Object.hasOwn(body, "store")).toBe(false);
          expect(body.tools ?? []).toEqual([]);
          expect(body.max_tokens ?? body.max_completion_tokens).toBe(4_096);
        },
        params,
        defaultParams,
      );
    },
  );

  it("keeps agent-specific utility payloads separate for a shared model", async () => {
    await withTitleProvider(
      "Agent payload verified",
      async ({ cfg, requests }) => {
        cfg.agents!.entries = {
          alpha: {
            models: {
              [modelRef]: {
                params: {
                  chatTemplateKwargs: { enable_thinking: true },
                  extraBody: { min_p: 0.3 },
                },
              },
            },
            params: { chat_template_kwargs: { enable_thinking: false } },
          },
          beta: {
            models: {
              [modelRef]: {
                params: {
                  chatTemplateKwargs: { enable_thinking: true },
                  extraBody: { min_p: 0.7 },
                },
              },
            },
          },
        };
        for (const agentId of ["alpha", "beta", "alpha"]) {
          await expect(
            prepareDashboardSessionTitle({
              cfg,
              agentId,
              userMessage: "Compare agent-specific utility parameters.",
            }),
          ).resolves.toBe("Agent payload verified");
        }
        expect(
          requests.map(({ body }) => ({
            template: body.chat_template_kwargs,
            minP: body.min_p,
          })),
        ).toEqual([
          { template: { enable_thinking: false }, minP: 0.3 },
          { template: { enable_thinking: true }, minP: 0.7 },
          { template: { enable_thinking: false }, minP: 0.3 },
        ]);
      },
      { chat_template_kwargs: { enable_thinking: false }, extra_body: { min_p: 0.1 } },
    );
  });

  it.each([
    [
      "closed reasoning",
      "<think>private</think>Invoice follow-up",
      "Invoice follow-up",
      "Invoice follow-up",
    ],
    ["unclosed reasoning", "<think>private", "private", null],
    ["namespaced reasoning", "<mm:think>private", "private", null],
    [
      "trailing reasoning",
      "Invoice follow-up<think>private",
      "Invoice follow-up<think>private",
      "Invoice follow-up",
    ],
    [
      "literal code",
      "Debug `<think>` parsing",
      "Debug `<think>` parsing",
      "Debug `<think>` parsing",
    ],
  ] as const)(
    "separates %s from ordinary completion recovery",
    async (_name, raw, ordinary, title) => {
      await withTitleProvider(raw, async ({ cfg, agentDir, requests }) => {
        const task = { agentId: "main", agentDir, timeoutMs: 5_000 };
        await expect(
          runIsolatedCompletion({
            ...task,
            config: cfg,
            provider,
            model,
            systemPrompt: "Return a concise title.",
            prompt: "Help me follow up on the invoice.",
          }),
        ).resolves.toMatchObject({ text: ordinary });
        await expect(
          generateConversationLabel({
            ...task,
            cfg,
            modelRef,
            prompt: "Return a concise title.",
            userMessage: "Help me follow up on the invoice.",
          }),
        ).resolves.toBe(title);
        expect(requests).toEqual(
          Array.from({ length: 2 }, () => ({
            authorization: "Bearer test-key",
            url: "/v1/chat/completions",
            body: expect.objectContaining({ model, stream: true }),
          })),
        );
      });
    },
  );

  it("persists the generated title through the dashboard owner", async () => {
    await withTitleProvider(
      "Invoice follow-up<think>private",
      async ({ cfg, storePath, requests }) => {
        const sessionKey = "agent:main:dashboard:title-proof";
        const entry = { sessionId: "title-proof-session", updatedAt: 1 };
        const scope = { agentId: "main", sessionKey, storePath };
        await replaceSessionEntry(scope, entry);
        await expect(
          maybeGenerateDashboardSessionTitle({
            ...scope,
            cfg,
            entry,
            sessionId: entry.sessionId,
            userMessage: "Help me follow up on the invoice.",
          }),
        ).resolves.toBe(true);
        const persisted = loadSessionEntry(scope);
        expect(requests).toHaveLength(1);
        expect(Object.hasOwn(requests[0]!.body, "store")).toBe(false);
        expect(persisted?.displayName).toBe("Invoice follow-up");
        expect(deriveSessionTitle(persisted)).toBe("Invoice follow-up");
      },
    );
  });
});
