import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { loadCodexWorkshopReviewNativeTestFixture } from "../extensions/codex/test-api.js";
import { createZeroUsageFixture } from "../src/agents/test-helpers/usage-fixtures.js";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import {
  listSessionEntriesReadOnly,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { Message } from "../src/llm/types.js";
import { withServer } from "../src/plugin-sdk/test-helpers/http-test-server.js";
import { acquirePluginRegistryForInspection } from "../src/plugins/loader.js";
import { withPluginRuntimeRegistryScope } from "../src/plugins/runtime/gateway-request-scope.js";
import { runSkillExperienceReview } from "../src/skills/workshop/experience-review.js";
import { createExperienceReviewCandidate } from "../src/skills/workshop/experience-review.test-support.js";
import { listWorkshopChanges } from "../src/skills/workshop/library.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import {
  writeOpenAiResponsesText,
  writeOpenAiResponsesSse,
} from "./helpers/openai-responses-sse.js";
import { withinTest } from "./helpers/promise.js";

// Exercise a declared first-party route while the private native home owns the synthetic transport.
const MODEL = "gpt-5.4";
const OLD = "OLD_HISTORY_NOT_NEEDED_FOR_NATIVE_REVIEW";
const USER = "RECENT_USER_EVIDENCE: verify the published generation.";
const TOOL = "RECENT_TOOL_EVIDENCE: generation endpoint returned release-42.";
const ASSISTANT = "RECENT_ASSISTANT_EVIDENCE: public generation verified.";
const WORKSPACE = "WORKSPACE_INSTRUCTIONS_NOT_NEEDED_FOR_NATIVE_REVIEW";
const FOREGROUND = "FOREGROUND_INSTRUCTIONS_NOT_NEEDED_FOR_NATIVE_REVIEW";
const SKILLS = "FOREGROUND_SKILLS_NOT_NEEDED_FOR_NATIVE_REVIEW";

function reviewMessages(): Message[] {
  const assistant = {
    api: "openai-responses" as const,
    provider: "openai",
    model: MODEL,
    usage: createZeroUsageFixture(),
  };
  return [
    { role: "user", content: `${OLD} `.repeat(8_000), timestamp: 1 },
    { role: "user", content: USER, timestamp: 2 },
    {
      ...assistant,
      role: "assistant",
      content: [{ type: "toolCall", id: "verify-generation", name: "exec", arguments: {} }],
      stopReason: "toolUse",
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "verify-generation",
      toolName: "exec",
      content: [{ type: "text", text: TOOL }],
      isError: false,
      timestamp: 4,
    },
    {
      ...assistant,
      role: "assistant",
      content: [{ type: "text", text: ASSISTANT }],
      stopReason: "stop",
      timestamp: 5,
    },
  ];
}

type ResponsesRequest = {
  model?: string;
  max_output_tokens?: number;
  tools?: Array<{ type?: string; name?: string }>;
};

const signal = AbortSignal.timeout(150_000);
// A short root also keeps the real native Unix socket within macOS's path limit.
await withOpenClawTestState(
  {
    prefix: "oc-wr-",
    env: {
      OPENAI_API_KEY: undefined,
      OPENAI_BASE_URL: undefined,
      OPENAI_TOKEN: undefined,
      OPENAI_OAUTH_TOKEN: undefined,
      CODEX_API_KEY: undefined,
      CODEX_HOME: undefined,
    },
  },
  async (state) => {
    const requests: string[] = [];
    const authHeaders: Array<string | undefined> = [];
    let responseMode: "success" | "http-failure" | "stream-failure" = "success";
    const providerErrors: unknown[] = [];
    await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), WORKSPACE);
    await withServer(
      (request, response) => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        void readText(request)
          .then((body) => {
            requests.push(body);
            authHeaders.push(request.headers.authorization);
            if (responseMode === "http-failure") {
              response.writeHead(503).end("Synthetic transient failure");
              return;
            }
            if (responseMode === "stream-failure") {
              writeOpenAiResponsesSse(response, [
                { type: "response.created", response: { id: "incomplete" } },
              ]);
              return;
            }
            writeOpenAiResponsesText(response, {
              text: "NO_REPLY",
              messageId: "workshop-noop-message",
              responseId: "workshop-noop-response",
            });
          })
          .catch((error: unknown) => {
            providerErrors.push(error);
            response.writeHead(500).end();
          });
      },
      async (baseUrl) => {
        const { createWorkshopReviewNativeFixture } =
          await loadCodexWorkshopReviewNativeTestFixture();
        const native = await createWorkshopReviewNativeFixture({
          root: state.root,
          baseUrl: `${baseUrl}/v1`,
          modelId: MODEL,
          signal,
          apiKey: "synthetic-configured-workshop-account",
        });
        let review: Promise<void> | undefined;
        try {
          const candidate = await createExperienceReviewCandidate(
            "codex-native",
            reviewMessages(),
            { workspaceDir: state.workspaceDir, modelId: MODEL },
          );
          // Replace the helper's OpenAI transport/auth config, not just its runtime label.
          const config: OpenClawConfig = {
            agents: {
              entries: { main: {} },
              defaults: {
                workspace: state.workspaceDir,
                model: { primary: `openai/${MODEL}` },
                models: { [`openai/${MODEL}`]: { agentRuntime: { id: "codex" } } },
              },
            },
            tools: { codeMode: false },
            skills: { workshop: { autonomous: { mode: "auto" } } },
            plugins: {
              allow: ["codex", "openai"],
              entries: {
                codex: {
                  enabled: true,
                  config: {
                    sessionCatalog: { enabled: false },
                    codexDynamicToolsLoading: "direct",
                    appServer: {
                      ...native.appServer,
                      approvalPolicy: "never",
                      sandbox: "read-only",
                      enableUltrafast: false,
                      loopDetectionPreToolUseRelay: false,
                    },
                  },
                },
              },
            },
          };
          candidate.config = config;
          Object.assign(candidate.ctx.foregroundPromptContext, {
            agentHarnessId: "codex",
            agentDir: state.agentDir(),
            extraSystemPrompt: FOREGROUND,
            skillsSnapshot: { prompt: SKILLS, skills: [] },
            clientTools: [
              {
                type: "function",
                function: {
                  name: "foreground_client_tool",
                  parameters: { type: "object", properties: {} },
                },
              },
            ],
          } satisfies Partial<typeof candidate.ctx.foregroundPromptContext>);
          await state.writeConfig(config);
          setRuntimeConfigSnapshot(config);
          const sourceBefore = await loadTranscriptEvents(candidate.source);
          const scope = { agentId: "main", storePath: candidate.source.storePath };
          const entriesBefore = listSessionEntriesReadOnly(scope);

          review = runSkillExperienceReview(candidate);
          await withinTest(review, signal);

          assert.deepEqual(providerErrors, []);
          assert.equal(requests.length, 1);
          assert.deepEqual(authHeaders, ["Bearer synthetic-configured-workshop-account"]);
          const serialized = requests[0]!;
          // These sentinels occur only in their respective source message types.
          for (const evidence of [USER, TOOL, ASSISTANT]) {
            assert.ok(serialized.includes(evidence), `Missing ${evidence}`);
          }
          for (const excluded of [OLD, WORKSPACE, FOREGROUND, SKILLS, "foreground_client_tool"]) {
            assert.ok(!serialized.includes(excluded), `Leaked ${excluded}`);
          }
          const payload = JSON.parse(serialized) as ResponsesRequest;
          assert.equal(payload.model, MODEL);
          assert.equal(payload.max_output_tokens, undefined);
          assert.deepEqual(
            payload.tools?.map(({ type, name }) => ({ type, name })),
            [{ type: "function", name: "skill_workshop" }],
          );
          assert.deepEqual(await listWorkshopChanges("main"), []);
          assert.deepEqual(await loadTranscriptEvents(candidate.source), sourceBefore);
          // A detached review must not create a second durable OpenClaw session either.
          assert.deepEqual(listSessionEntriesReadOnly(scope), entriesBefore);

          for (const mode of ["http-failure", "stream-failure"] as const) {
            responseMode = mode;
            requests.length = 0;
            await assert.rejects(runSkillExperienceReview(candidate));
            assert.equal(requests.length, 1, `${mode} bought another inference request`);
          }
          responseMode = "success";
          requests.length = 0;
          let revoked = false;
          const restoreRequest = native.beforeNextTurn(async () => {
            const updated = await upsertSessionEntryCore(candidate.source, {
              lifecycleRevision: "revoked-before-dispatch",
            });
            assert.equal(updated?.lifecycleRevision, "revoked-before-dispatch");
            revoked = true;
          });
          try {
            const outcome = await runSkillExperienceReview(candidate).then(
              () => undefined,
              (error: unknown) => error,
            );
            assert.ok(revoked, "The test never reached the native turn-dispatch boundary");
            assert.equal(requests.length, 0, "Revoked source reached provider I/O");
            assert.ok(outcome instanceof Error, "Revoked source review unexpectedly succeeded");
          } finally {
            restoreRequest();
          }
          const attachedCandidate = await createExperienceReviewCandidate(
            "codex-native-attached",
            reviewMessages(),
            {
              workspaceDir: state.workspaceDir,
              modelId: MODEL,
            },
          );
          attachedCandidate.config = config;
          attachedCandidate.ctx.foregroundPromptContext.agentHarnessId = "codex";
          const attachedRoot = path.join(state.root, "attached");
          await fs.mkdir(attachedRoot);
          const attached = await createWorkshopReviewNativeFixture({
            root: attachedRoot,
            baseUrl: `${baseUrl}/v1`,
            modelId: MODEL,
            signal,
            apiKey: "synthetic-separate-attached-account",
          });
          try {
            await upsertSessionEntryCore(attachedCandidate.source, {
              agentHarnessId: "codex",
              modelSelectionLocked: true,
            });
            await attached.bindAttachedSource(attachedCandidate.source);
            const registry = await acquirePluginRegistryForInspection({
              config,
              workspaceDir: state.workspaceDir,
              onlyPluginIds: ["codex", "openai"],
              preferBuiltPluginArtifacts: false,
            });
            try {
              await withPluginRuntimeRegistryScope(registry.registry, () =>
                assert.rejects(
                  runSkillExperienceReview(attachedCandidate),
                  /credential-owning connection/,
                ),
              );
            } finally {
              await registry.release();
            }
            assert.equal(requests.length, 0, "Attached account review reached provider I/O");
          } finally {
            await attached.close();
          }
        } finally {
          try {
            await native.close();
          } finally {
            // Always join the review, including when native shutdown fails.
            await review?.catch(() => undefined);
          }
        }
        // Inspect after joined shutdown so deferred rollout writes cannot escape the check.
        const nativeFiles = await fs.readdir(native.codexHome, { recursive: true });
        assert.deepEqual(
          nativeFiles.filter((file) => /^rollout-.*\.jsonl$/.test(path.basename(file))),
          [],
        );
      },
    );
  },
);
process.stdout.write("WORKSHOP_NATIVE_PROOF_OK\n");
