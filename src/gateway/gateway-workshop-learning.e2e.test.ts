import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry, loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runSkillExperienceReview } from "../skills/workshop/experience-review.js";
import { createExperienceReviewCandidate } from "../skills/workshop/experience-review.test-support.js";
import { listWorkshopChanges } from "../skills/workshop/library.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { createTrackedProvider } from "./test-helpers.tracked-provider.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type ProviderRequest = {
  max_output_tokens?: number;
  tools?: Array<{ name?: string }>;
};

async function withResponsesProvider(
  handle: (body: string, response: ServerResponse) => void | Promise<void>,
  run: (baseUrl: string, errors: unknown[]) => Promise<void>,
) {
  const provider = createTrackedProvider((body, response, request) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    return handle(body, response);
  });
  try {
    await run(await provider.listen(), provider.errors);
  } finally {
    await provider.close();
  }
}

describe("Gateway automatic Workshop learning", () => {
  it(
    "sends one bounded review request and stops on a provider TPM rate limit",
    { timeout: 60_000 },
    async () => {
      const state = await createOpenClawTestState({
        prefix: "openclaw-workshop-review-rate-limit-",
      });
      const requests: string[] = [];
      const oldHistory = "OLD_HISTORY_NOT_NEEDED_FOR_REVIEW ".repeat(20_000);
      const workspaceInstructions = "WORKSPACE_INSTRUCTIONS_NOT_NEEDED_FOR_REVIEW";
      const recentEvidence =
        "RECENT_VERIFIED_PROCEDURE: confirm the public generation matches the release.";
      try {
        await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), workspaceInstructions);
        await withResponsesProvider(
          (body, response) => {
            requests.push(body);
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
          },
          async (baseUrl, providerErrors) => {
            const candidate = await createExperienceReviewCandidate(
              "http-tpm-limit",
              [
                { role: "user", content: oldHistory, timestamp: 1 },
                { role: "user", content: recentEvidence, timestamp: 2 },
              ],
              {
                workspaceDir: state.workspaceDir,
                modelId: "gpt-workshop-rate-limit-test",
                baseUrl,
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
            setRuntimeConfigSnapshot(candidate.config);
            await state.writeConfig(candidate.config);

            await expect(runSkillExperienceReview(candidate)).rejects.toThrow(/rate limit/i);

            expect(providerErrors).toEqual([]);
            expect(requests).toHaveLength(1);
            const serialized = requests[0]!;
            expect(Buffer.byteLength(serialized)).toBeLessThan(64 * 1024);
            expect(serialized).toContain(recentEvidence);
            for (const excluded of ["OLD_HISTORY_NOT_NEEDED_FOR_REVIEW", workspaceInstructions]) {
              expect(serialized).not.toContain(excluded);
            }
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
      const originalSkill = `---
name: map-publication
description: Publish map generations and verify public routing.
---
# Map publication

Read references/activation.md before publishing.
${oldRule}

${Array.from({ length: 180 }, (_, index) => `Tile family ${index}: preserve its independent regional routing requirement during release verification.`).join("\n")}

Retain the distinct rollback procedure after verifying the previous public generation.`;
      const originalSupport = `# Activation\n\n${oldRule}\nKeep the activation receipt until verification completes.\n`;
      try {
        await fs.writeFile(outsideFile, outsideContent);
        await Promise.all(
          Array.from({ length: 9 }, (_, index) =>
            fs.writeFile(
              path.join(state.workspaceDir, `receipt-${index + 1}.txt`),
              `Release step ${index + 1}: ${index === 8 ? "public generation matches the submitted release" : "accepted"}.\n`,
            ),
          ),
        );
        await withResponsesProvider(
          async (body, response) => {
            const payload = JSON.parse(body) as ProviderRequest;
            if (foregroundRequests < 10) {
              foregroundRequests += 1;
              if (foregroundRequests < 10) {
                writeToolCall(
                  response,
                  "read",
                  {
                    path: `receipt-${foregroundRequests}.txt`,
                  },
                  10,
                  10,
                );
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
              writeToolCall(response, next.name, next.args, 10, 10);
            } else {
              writeOpenAiResponsesText(response, {
                text: "NO_REPLY",
                messageId: "review_done",
                responseId: "review_done",
              });
            }
          },
          async (baseUrl, providerErrors) => {
            const provider = buildMockOpenAiResponsesProvider(baseUrl, "workshop-learning");
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
            const supportFile = path.join(path.dirname(skillFile), "references/activation.md");
            await fs.mkdir(path.dirname(supportFile), { recursive: true });
            await fs.writeFile(skillFile, originalSkill);
            await fs.writeFile(supportFile, originalSupport);
            const reason = "require the public generation to match the release";
            const workshopCall = (action: string, args: Record<string, unknown> = {}) => ({
              name: "skill_workshop",
              args: { action, name: "map-publication", ...args },
            });
            const patch = { old_text: oldRule, new_text: newRule, reason };
            reviewActions = [
              workshopCall("view"),
              workshopCall("patch", patch),
              workshopCall("patch", { ...patch, file_path: "references/activation.md" }),
            ];
            gateway = await startGatewayWithClient({
              cfg: config,
              configPath: state.configPath,
              token,
              scopes: ["operator.admin", "operator.read", "operator.write"],
            });
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
            await expect
              .poll(() => JSON.stringify(loadTranscriptEventsSync(source)), {
                timeout: 80_000,
                interval: 100,
              })
              .toContain("💾 Learned:");
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
            for (const { file, original } of [
              { file: skillFile, original: originalSkill },
              { file: supportFile, original: originalSupport },
            ]) {
              expect(await fs.readFile(file, "utf8")).toBe(original.replace(oldRule, newRule));
            }
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
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "Workshop learning proof cleanup" });
        }
        await state.cleanup();
      }
    },
  );
});
