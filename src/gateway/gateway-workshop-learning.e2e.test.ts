import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry, loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { runSkillExperienceReview } from "../skills/workshop/experience-review.js";
import { createExperienceReviewCandidate } from "../skills/workshop/experience-review.test-support.js";
import { listWorkshopChanges } from "../skills/workshop/library.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type ProviderRequest = {
  max_output_tokens?: number;
  tools?: Array<{ name?: string }>;
  input?: Array<{
    type?: string;
    role?: string;
    call_id?: string;
    output?: unknown;
    content?: Array<{ text?: string }>;
  }>;
};

function respondWithTool(
  response: ServerResponse,
  callId: string,
  name: string,
  args: Record<string, unknown>,
): void {
  const item = {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${callId}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ]);
}

describe("Gateway automatic Workshop learning", () => {
  it(
    "sends one bounded review request and stops on a provider TPM rate limit",
    { timeout: 60_000 },
    async () => {
      const state = await createOpenClawTestState({
        layout: "home",
        prefix: "openclaw-workshop-review-rate-limit-",
      });
      const requests: string[] = [];
      const providerErrors: unknown[] = [];
      const oldHistory = "OLD_HISTORY_NOT_NEEDED_FOR_REVIEW ".repeat(20_000);
      const workspaceInstructions = "WORKSPACE_INSTRUCTIONS_NOT_NEEDED_FOR_REVIEW";
      const skillBundle = "SKILL_BUNDLE_NOT_NEEDED_FOR_REVIEW";
      const foregroundInstructions = "FOREGROUND_INSTRUCTIONS_NOT_NEEDED_FOR_REVIEW";
      const recentEvidence =
        "RECENT_VERIFIED_PROCEDURE: confirm the public generation matches the release.";
      try {
        await fs.mkdir(state.workspaceDir, { recursive: true });
        await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), workspaceInstructions);
        await withServer(
          (request, response) => {
            void (async () => {
              if (request.method !== "POST" || request.url !== "/v1/responses") {
                response.writeHead(404).end();
                return;
              }
              requests.push(await readText(request));
              response.writeHead(429, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  error: {
                    message: "Rate limit reached on tokens per min (TPM). Try again later.",
                    type: "tokens",
                    code: "rate_limit_exceeded",
                  },
                }),
              );
            })().catch((error: unknown) => {
              providerErrors.push(error);
              response.writeHead(500).end(String(error));
            });
          },
          async (baseUrl) => {
            const candidate = await createExperienceReviewCandidate(
              "http-tpm-limit",
              [
                { role: "user", content: oldHistory, timestamp: 1 },
                { role: "user", content: recentEvidence, timestamp: 2 },
              ],
              {
                workspaceDir: state.workspaceDir,
                modelId: "gpt-workshop-rate-limit-test",
                baseUrl: `${baseUrl}/v1`,
                apiKey: "synthetic-workshop-provider-key",
              },
            );
            candidate.config.models!.providers!.openai!.models[0]!.maxTokens = 128_000;
            candidate.config.agents!.defaults!.models![
              "openai/gpt-workshop-rate-limit-test"
            ]!.params = {
              maxTokens: 128_000,
              transport: "sse",
              openaiWsWarmup: false,
            };
            candidate.ctx.foregroundPromptContext.promptCacheKey = "foreground-cache-affinity";
            candidate.ctx.foregroundPromptContext.sourceReplyDeliveryMode = "message_tool_only";
            candidate.ctx.foregroundPromptContext.skillsSnapshot = {
              prompt: skillBundle.repeat(3_000),
              skills: [],
            };
            candidate.ctx.foregroundPromptContext.extraSystemPrompt =
              foregroundInstructions.repeat(3_000);
            candidate.ctx.foregroundPromptContext.clientTools = [
              {
                type: "function",
                function: {
                  name: "foreground_client_tool",
                  parameters: { type: "object", properties: {} },
                },
              },
            ];
            setRuntimeConfigSnapshot(candidate.config);
            await state.writeConfig(candidate.config);

            await expect(runSkillExperienceReview(candidate)).rejects.toThrow(/rate limit/i);

            expect(providerErrors).toEqual([]);
            expect(requests).toHaveLength(1);
            const serialized = requests[0]!;
            // This is the final HTTP body, including system instructions and tool schemas.
            expect(Buffer.byteLength(serialized)).toBeLessThan(64 * 1024);
            expect(serialized).toContain(recentEvidence);
            expect(serialized).not.toContain("OLD_HISTORY_NOT_NEEDED_FOR_REVIEW");
            expect(serialized).not.toContain(workspaceInstructions);
            expect(serialized).not.toContain(skillBundle);
            expect(serialized).not.toContain(foregroundInstructions);
            expect(serialized).not.toContain("foreground-cache-affinity");
            const payload = JSON.parse(serialized) as ProviderRequest;
            expect(payload.max_output_tokens).toBe(2_048);
            expect(payload.tools?.map((tool) => tool.name)).toEqual(["skill_workshop"]);
          },
        );
      } finally {
        await state.cleanup();
      }
    },
  );

  it(
    "patches a learned skill through skill_workshop and announces it without rewriting source history",
    { timeout: 150_000 },
    async () => {
      const state = await createOpenClawTestState({
        layout: "home",
        prefix: "openclaw-gateway-workshop-learning-",
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      });
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let reviewWarnings: ReturnType<typeof createWarnLogCapture> | undefined;
      const providerErrors: unknown[] = [];
      const reviewRequests: ProviderRequest[] = [];
      const reviewStarted = createDeferred();
      const releaseReview = createDeferred();
      let reviewActions: Array<{ name: string; args: Record<string, unknown> }> = [];
      let foregroundRequests = 0;
      const outsideFile = path.join(state.workspaceDir, "operator-owned.txt");
      const outsideContent = "OUTSIDE_WORKSHOP_SENTINEL_MUST_NOT_ENTER_REVIEW\n";
      const oldRule = "Declare publication complete when the health check is green.";
      const newRule =
        "Declare publication complete only when the public generation matches the release.";
      const originalSkill = [
        "---",
        "name: map-publication",
        "description: Publish map generations and verify public routing.",
        "---",
        "# Map publication",
        "",
        "Read references/activation.md before publishing.",
        oldRule,
        "",
        ...Array.from(
          { length: 180 },
          (_, index) =>
            `Tile family ${index}: preserve its independent regional routing requirement during release verification.`,
        ),
        "",
        "Retain the distinct rollback procedure after verifying the previous public generation.",
      ].join("\n");
      const originalSupport = `# Activation\n\n${oldRule}\nKeep the activation receipt until verification completes.\n`;
      try {
        await fs.mkdir(state.workspaceDir, { recursive: true });
        await fs.writeFile(outsideFile, outsideContent);
        await Promise.all(
          Array.from({ length: 9 }, (_, index) =>
            fs.writeFile(
              path.join(state.workspaceDir, `receipt-${index + 1}.txt`),
              `Release step ${index + 1}: ${index === 8 ? "public generation matches the submitted release" : "accepted"}.\n`,
            ),
          ),
        );
        await withServer(
          (request, response) => {
            void (async () => {
              if (request.method !== "POST" || request.url !== "/v1/responses") {
                response.writeHead(404).end();
                return;
              }
              const payload = JSON.parse(await readText(request)) as ProviderRequest;
              if (foregroundRequests < 10) {
                foregroundRequests += 1;
                if (foregroundRequests < 10) {
                  respondWithTool(response, `foreground_${foregroundRequests}`, "read", {
                    path: `receipt-${foregroundRequests}.txt`,
                  });
                } else {
                  writeOpenAiResponsesText(response, {
                    text: "Verified all receipts. Public generation matches the release; health alone was insufficient.",
                    messageId: "foreground_done",
                    responseId: "foreground_done",
                  });
                }
                return;
              }
              reviewRequests.push(payload);
              if (reviewRequests.length === 1) {
                reviewStarted.resolve();
                await releaseReview.promise;
              }
              const next = reviewActions[reviewRequests.length - 1];
              if (next) {
                respondWithTool(response, `review_${reviewRequests.length}`, next.name, next.args);
              } else {
                writeOpenAiResponsesText(response, {
                  text: "NO_REPLY",
                  messageId: "review_done",
                  responseId: "review_done",
                });
              }
            })().catch((error: unknown) => {
              providerErrors.push(error);
              response.writeHead(500).end(String(error));
            });
          },
          async (baseUrl) => {
            const provider = buildMockOpenAiResponsesProvider(`${baseUrl}/v1`, "workshop-learning");
            const token = "isolated-workshop-learning-token";
            const config = {
              agents: {
                defaults: {
                  workspace: state.workspaceDir,
                  skipBootstrap: true,
                  model: { primary: provider.modelRef },
                  models: {
                    [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                  },
                },
              },
              gateway: { auth: { mode: "token", token } },
              models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
              plugins: { slots: { memory: "none" } },
              tools: { profile: "coding" },
              skills: { load: { watch: false }, workshop: { autonomous: { mode: "auto" } } },
            } satisfies OpenClawConfig;
            const workshop = resolveWorkshopSkillsDir(config, "main");
            const skillFile = path.join(workshop, "map-publication", "SKILL.md");
            const supportFile = path.join(
              workshop,
              "map-publication",
              "references",
              "activation.md",
            );
            await fs.mkdir(path.dirname(supportFile), { recursive: true });
            await fs.writeFile(skillFile, originalSkill);
            await fs.writeFile(supportFile, originalSupport);
            const reason = "require the public generation to match the release";
            const workshopCall = (args: Record<string, unknown>) => ({
              name: "skill_workshop",
              args,
            });
            reviewActions = [
              workshopCall({ action: "view", name: "map-publication" }),
              workshopCall({
                action: "patch",
                name: "map-publication",
                old_text: oldRule,
                new_text: newRule,
                reason,
              }),
              workshopCall({
                action: "patch",
                name: "map-publication",
                file_path: "references/activation.md",
                old_text: oldRule,
                new_text: newRule,
                reason,
              }),
            ];
            gateway = await startGatewayWithClient({
              cfg: config,
              configPath: state.configPath,
              token,
              scopes: ["operator.admin", "operator.read", "operator.write"],
            });
            reviewWarnings = createWarnLogCapture("openclaw-gateway-workshop-learning");
            const sessionKey = "agent:main:workshop-learning-proof";
            const accepted = await gateway.client.request<{ runId: string; status: string }>(
              "agent",
              {
                sessionKey,
                message:
                  "Check the nine release receipts individually. For future map publications, correct the reusable procedure: a green health check is insufficient; confirm the public generation matches the release.",
                deliver: false,
                idempotencyKey: randomUUID(),
              },
            );
            expect(accepted.status).toBe("accepted");
            const completed = await gateway.client.request<{ status: string }>(
              "agent.wait",
              { runId: accepted.runId, timeoutMs: 45_000 },
              { timeoutMs: 50_000 },
            );
            expect(completed.status).toBe("ok");
            expect(foregroundRequests).toBe(10);
            const scope = {
              agentId: "main",
              sessionKey,
              storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
            };
            const sourceEntry = loadSessionEntry(scope);
            if (!sourceEntry) {
              throw new Error("The completed foreground session is missing.");
            }
            const source = { ...scope, sessionId: sourceEntry.sessionId };
            const originalTranscript = loadTranscriptEventsSync(source);
            await withTestTimeout(
              reviewStarted.promise,
              45_000,
              "The idle Workshop review did not reach the provider.",
            );
            releaseReview.resolve();
            // The review announces its change in the originating conversation, where the
            // foreground agent sees it next turn and can undo it.
            await expect
              .poll(() => JSON.stringify(loadTranscriptEventsSync(source)), {
                timeout: 80_000,
                interval: 100,
              })
              .toContain("💾 Learned:")
              .catch(async (cause: unknown) => {
                throw new Error(
                  JSON.stringify({
                    reviewResults: reviewRequests.map((request) =>
                      request.input?.findLast((item) => item.type === "function_call_output"),
                    ),
                    changes: await listWorkshopChanges("main"),
                    providerErrors,
                    reviewFailure: await reviewWarnings?.findText("skill experience review failed"),
                  }),
                  { cause },
                );
              });
            const skill = await fs.readFile(skillFile, "utf8");
            const support = await fs.readFile(supportFile, "utf8");
            const outside = await fs.readFile(outsideFile, "utf8");
            const finalTranscript = loadTranscriptEventsSync(source);
            const changes = await listWorkshopChanges("main");
            expect(providerErrors).toEqual([]);
            expect(reviewRequests).toHaveLength(reviewActions.length + 1);
            expect(outside).toBe(outsideContent);
            for (const reviewRequest of reviewRequests) {
              const evidence = JSON.stringify(reviewRequest);
              expect(evidence).not.toContain(outsideContent.trim());
            }
            expect(skill).toBe(originalSkill.replace(oldRule, newRule));
            expect(support).toBe(originalSupport.replace(oldRule, newRule));
            expect(changes).toHaveLength(2);
            expect(changes.every((change) => change.actor === "review")).toBe(true);
            expect(finalTranscript.slice(0, originalTranscript.length)).toEqual(originalTranscript);
            const notice = JSON.stringify(finalTranscript.slice(originalTranscript.length));
            expect(notice).toContain(`updated \`map-publication\` (${reason})`);
            expect(notice).toContain('Say \\"undo\\" to revert this skill change.');
          },
        );
      } finally {
        releaseReview.resolve();
        reviewWarnings?.cleanup();
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "Workshop learning proof cleanup" });
        }
        await state.cleanup();
      }
    },
  );
});
