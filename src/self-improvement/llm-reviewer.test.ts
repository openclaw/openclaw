import type { Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildSelfImprovementLocalOpenAiPayloadHint,
  buildSelfImprovementLocalReviewerPayloadHint,
  preflightSelfImprovementReviewModels,
  redactSelfImprovementLlmText,
  resetSelfImprovementLlmReviewerPreflightCacheForTest,
  reviewSelfImprovementGroupsWithLlm,
  summarizeSelfImprovementModelReadiness,
  stripSelfImprovementLlmReasoning,
} from "./llm-reviewer.js";
import type { SelfImprovementRecommendationGroup } from "./types.js";

const now = Date.parse("2026-05-07T12:00:00.000Z");

function group(): SelfImprovementRecommendationGroup {
  return {
    id: "sig_test",
    groupKey: "smoke_failure:task_group:dashboard-smoke",
    title: "Dashboard smoke failures",
    category: "smoke_failure",
    severity: "high",
    criticality: "high",
    priority: "high",
    status: "open",
    route: {
      role: "qa",
      targetAgentId: "qa-test-agent",
      targetAgentLabel: "QA Test Agent",
      reason: "Verification gap.",
    },
    count: 1,
    open: 1,
    acknowledged: 0,
    assigned: 0,
    inProgress: 0,
    reopened: 0,
    quarantined: 0,
    resolved: 0,
    dismissed: 0,
    requiresTests: true,
    requiresApproval: true,
    firstSeenAt: now,
    lastSeenAt: now,
    lastUpdatedAt: now,
    recommendationIds: ["sir_test"],
    topEvidence: [
      "Command /Users/openclaw/project/run.sh failed with token=abcdefghijklmnopqrstuvwxyz123456",
    ],
    recommendedAction: "Rerun the dashboard smoke.",
    analysis: {
      mode: "deterministic",
      summary: "One recommendation is ready.",
      generatedAt: now,
      confidence: 0.8,
      promptVersion: "self-improvement-deterministic-v1",
      evidenceCount: 1,
      safetyNotes: ["Recommendation-only."],
    },
  };
}

const passingPreflight: Parameters<
  typeof reviewSelfImprovementGroupsWithLlm
>[0]["preflight"] = async (params) => ({
  ok: true,
  status: params.local ? "passed" : "not_required",
  elapsedMs: params.local ? 7 : 0,
});

function configuredKimiCfg(): OpenClawConfig {
  return {
    models: {
      mode: "merge",
      providers: {
        "kimi-local": {
          baseUrl: "http://127.0.0.1:8000/v1",
          apiKey: "local-openclaw",
          api: "openai-completions",
          request: { allowPrivateNetwork: true },
          timeoutSeconds: 300,
          models: [
            {
              id: "moonshotai/Kimi-K2.6",
              name: "Kimi K2.6 Local",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 262_144,
              maxTokens: 16_384,
            },
          ],
        },
      },
    },
  };
}

describe("self-improvement LLM reviewer", () => {
  afterEach(() => {
    resetSelfImprovementLlmReviewerPreflightCacheForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("redacts local paths and token-like values before LLM review", () => {
    expect(
      redactSelfImprovementLlmText(
        "Command /Users/openclaw/project/run.sh failed with token=abcdefghijklmnopqrstuvwxyz123456",
      ),
    ).toContain("[local-path]");
    expect(
      redactSelfImprovementLlmText(
        "Command /Users/openclaw/project/run.sh failed with token=abcdefghijklmnopqrstuvwxyz123456",
      ),
    ).toContain("token=[redacted]");
  });

  it("adds local OpenAI-compatible JSON and top-p payload hints only for reviewer calls", async () => {
    const openAiCompletionsModel = {
      provider: "kimi-local",
      id: "moonshotai/Kimi-K2.6",
      name: "Kimi K2.6 Local",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8000/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 16384,
    } satisfies Model<"openai-completions">;
    const localHint = buildSelfImprovementLocalOpenAiPayloadHint({
      local: true,
      model: openAiCompletionsModel,
      topP: 0.95,
    });
    expect(localHint).toBeDefined();
    const payload = {
      model: "moonshotai/Kimi-K2.6",
      messages: [{ role: "user", content: "json only" }],
    };

    expect(await Promise.resolve(localHint?.(payload, openAiCompletionsModel))).toEqual({
      model: "moonshotai/Kimi-K2.6",
      messages: [{ role: "user", content: "json only" }],
      response_format: { type: "json_object" },
      top_p: 0.95,
    });
    expect(payload).not.toHaveProperty("response_format");
    expect(payload).not.toHaveProperty("top_p");
    expect(
      await Promise.resolve(
        localHint?.({ response_format: { type: "text" } }, openAiCompletionsModel),
      ),
    ).toEqual({
      response_format: { type: "text" },
      top_p: 0.95,
    });
    expect(await Promise.resolve(localHint?.({ top_p: 0.2 }, openAiCompletionsModel))).toEqual({
      top_p: 0.2,
      response_format: { type: "json_object" },
    });
    expect(
      await Promise.resolve(
        localHint?.({ response_format: { type: "text" }, top_p: 0.2 }, openAiCompletionsModel),
      ),
    ).toBeUndefined();
    expect(
      buildSelfImprovementLocalOpenAiPayloadHint({
        local: false,
        model: openAiCompletionsModel,
      }),
    ).toBeUndefined();
    expect(
      buildSelfImprovementLocalOpenAiPayloadHint({
        local: true,
        model: { api: "anthropic-messages" },
        topP: 0.95,
      }),
    ).toBeUndefined();
  });

  it("adds native Ollama JSON, thinking, and top-p payload hints for reviewer calls", async () => {
    const ollamaModel = {
      provider: "ollama",
      id: "qwen3.6:27b-q8_0",
      name: "Qwen3.6 27B Q8",
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 8192,
    } satisfies Model<"ollama">;
    const localHint = buildSelfImprovementLocalReviewerPayloadHint({
      local: true,
      model: ollamaModel,
      topP: 0.95,
    });
    expect(localHint).toBeDefined();
    const payload = {
      model: "qwen3.6:27b-q8_0",
      messages: [{ role: "user", content: "json only" }],
      options: { temperature: 0.2, num_predict: 8192 },
    };

    expect(await Promise.resolve(localHint?.(payload, ollamaModel))).toBe(payload);
    expect(payload).toEqual({
      model: "qwen3.6:27b-q8_0",
      messages: [{ role: "user", content: "json only" }],
      format: "json",
      think: false,
      options: { temperature: 0.2, num_predict: 8192, top_p: 0.95 },
    });

    const explicitPayload = {
      format: { type: "object" },
      think: "medium",
      options: { top_p: 0.3 },
    };
    expect(await Promise.resolve(localHint?.(explicitPayload, ollamaModel))).toBeUndefined();
    expect(explicitPayload).toEqual({
      format: { type: "object" },
      think: "medium",
      options: { top_p: 0.3 },
    });
    expect(
      buildSelfImprovementLocalReviewerPayloadHint({
        local: false,
        model: ollamaModel,
        topP: 0.95,
      }),
    ).toBeUndefined();
  });

  it("does not call completion unless hosted allowance, approval, env, and config gates pass", async () => {
    let calls = 0;
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: true,
      allowHostedEscalation: true,
      approved: false,
      env: { OPENCLAW_SELF_IMPROVEMENT_LLM: "1" },
      cfg: {} as OpenClawConfig,
      completion: async () => {
        calls += 1;
        return { text: "{}" };
      },
    });

    expect(result.status).toMatchObject({ mode: "fallback" });
    expect(result.status.attempts[0]).toMatchObject({
      tier: "hostedEscalation",
      status: "blocked",
    });
    expect(calls).toBe(0);
  });

  it("blocks direct hosted review without explicit hosted escalation allowance", async () => {
    let calls = 0;
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: true,
      approved: true,
      env: { OPENCLAW_SELF_IMPROVEMENT_LLM: "1" },
      cfg: {} as OpenClawConfig,
      completion: async () => {
        calls += 1;
        return { text: "{}" };
      },
    });

    expect(result.status).toMatchObject({
      mode: "fallback",
      reason: "Hosted LLM review requires explicit hosted escalation allowance.",
    });
    expect(result.status.attempts[0]).toMatchObject({
      tier: "hostedEscalation",
      status: "blocked",
    });
    expect(calls).toBe(0);
  });

  it("applies valid approved LLM JSON to matching groups only", async () => {
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: true,
      allowHostedEscalation: true,
      approved: true,
      env: { OPENCLAW_SELF_IMPROVEMENT_LLM: "1" },
      cfg: {} as OpenClawConfig,
      now,
      completion: async () => ({
        text: JSON.stringify({
          groups: [
            {
              groupId: "sig_test",
              summary: "LLM summary.",
              recommendedAction: "Ask QA for one rerun with proof.",
              confidence: 0.9,
              safetyNotes: ["No direct merge."],
            },
          ],
        }),
        modelId: "openai/gpt-5.5",
      }),
    });

    expect(result.status).toMatchObject({
      mode: "hosted_escalation",
      groupsReviewed: 1,
      modelId: "openai/gpt-5.5",
      modelTier: "hostedEscalation",
    });
    expect(result.groups[0]).toMatchObject({
      recommendedAction:
        "Ask QA for one rerun with proof. Before resolving, keep the item pending for owner or operator approval.",
      analysis: {
        mode: "hosted_escalation",
        summary: "LLM summary.",
        confidence: 0.9,
        schemaValidated: true,
      },
    });
  });

  it("selects Qwen3.6 Q8 as the default local-first review model", async () => {
    const calls: Array<{
      modelId?: string;
      maxTokens: number;
      temperature: number;
      topP?: number;
    }> = [];
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: passingPreflight,
      completion: async (params) => {
        calls.push({
          modelId: params.modelId,
          maxTokens: params.maxTokens,
          temperature: params.temperature,
          topP: params.topP,
        });
        return {
          text: JSON.stringify({
            groups: [
              {
                groupId: "sig_test",
                summary: "Local Qwen summary.",
                recommendedAction: "Route a bounded QA verification proposal.",
                confidence: 0.87,
              },
            ],
          }),
          modelId: params.modelId,
        };
      },
    });

    expect(calls).toEqual([
      {
        modelId: "ollama/qwen3.6:27b-q8_0",
        maxTokens: 8_192,
        temperature: 0.2,
        topP: 0.95,
      },
    ]);
    expect(result.status).toMatchObject({
      mode: "local_llm",
      modelTier: "primaryReview",
      groupsReviewedByLocalLlm: 1,
      schemaValidated: true,
    });
    expect(result.status.attempts[0]).toMatchObject({
      quantization: "Q8_0",
      parameters: "27B",
      contextWindow: 65_536,
      preflightStatus: "passed",
      preflightMs: 7,
    });
  });

  it("sends a strict JSON-object prompt contract to local reviewers", async () => {
    let capturedSystemPrompt = "";
    let capturedUserPrompt = "";
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: passingPreflight,
      completion: async (params) => {
        capturedSystemPrompt = params.systemPrompt;
        capturedUserPrompt = params.userPrompt;
        return {
          text: JSON.stringify({
            groups: [
              {
                groupId: "sig_test",
                summary: "Strict prompt contract summary.",
                recommendedAction: "Keep the routed recommendation pending for QA proof.",
                confidence: 0.84,
              },
            ],
          }),
          modelId: params.modelId,
        };
      },
    });

    expect(result.status).toMatchObject({
      mode: "local_llm",
      schemaValidated: true,
    });
    expect(capturedSystemPrompt).toContain("The first character must be {");
    expect(capturedSystemPrompt).toContain('return exactly {"groups":[]}');
    expect(capturedUserPrompt).toContain("Your response must start with { and end with }.");
    expect(capturedUserPrompt).toContain('return {"groups":[]}');
    expect(capturedUserPrompt).toContain('"groupId":"sig_test"');
  });

  it("does not preflight or claim schema validation when there are no groups to review", async () => {
    let preflightCalls = 0;
    let completionCalls = 0;
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: async () => {
        preflightCalls += 1;
        return { ok: true, status: "passed", elapsedMs: 1 };
      },
      completion: async () => {
        completionCalls += 1;
        return { text: "{}" };
      },
    });

    expect(preflightCalls).toBe(0);
    expect(completionCalls).toBe(0);
    expect(result).toMatchObject({
      groups: [],
      status: {
        mode: "disabled",
        reviewPolicy: "local_first",
        attempts: [],
        schemaValidated: false,
        groupsReviewedByLocalLlm: 0,
        reviewModelId: "ollama/qwen3.6:27b-q8_0",
        fallbackModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      },
    });
    if (result.status.mode !== "disabled") {
      throw new Error("Expected disabled review status");
    }
    expect(result.status.reason).toContain("No grouped self-improvement recommendations");
  });

  it("blocks hosted-looking primary review models in local-first runs and retries local fallback", async () => {
    const calls: string[] = [];
    const preflightCalls: string[] = [];
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      reviewModelId: "openai/gpt-5.5",
      cfg: {} as OpenClawConfig,
      now,
      preflight: async (params) => {
        preflightCalls.push(params.modelId ?? "");
        return {
          ok: true,
          status: params.local ? "passed" : "not_required",
          elapsedMs: params.local ? 9 : 0,
        };
      },
      completion: async (params) => {
        calls.push(params.modelId ?? "");
        return {
          text: JSON.stringify({
            groups: [
              {
                groupId: "sig_test",
                summary: "Qwen fallback handled the local-first review safely.",
                recommendedAction: "Keep the routed recommendation pending for QA proof.",
                confidence: 0.8,
              },
            ],
          }),
          modelId: params.modelId,
        };
      },
    });

    expect(preflightCalls).toEqual(["ollama/openclaw-control-qwen3-30b-q6-chatfix:latest"]);
    expect(calls).toEqual(["ollama/openclaw-control-qwen3-30b-q6-chatfix:latest"]);
    expect(result.status).toMatchObject({
      mode: "local_retry",
      modelTier: "crossCheck",
      schemaValidated: true,
      groupsReviewedByLocalLlm: 1,
    });
    expect(result.status.attempts).toMatchObject([
      {
        tier: "primaryReview",
        modelId: "openai/gpt-5.5",
        status: "blocked",
      },
      {
        tier: "crossCheck",
        modelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
        status: "success",
        preflightStatus: "passed",
      },
    ]);
    expect(result.status.attempts[0]?.error).toContain("must be local");
  });

  it("strips reasoning and retries invalid local JSON once with chatfix fallback", async () => {
    const calls: string[] = [];
    vi.spyOn(Date, "now")
      .mockReturnValue(now + 300)
      .mockReturnValueOnce(now + 100)
      .mockReturnValueOnce(now + 175)
      .mockReturnValueOnce(now + 200)
      .mockReturnValueOnce(now + 290);
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: passingPreflight,
      completion: async (params) => {
        calls.push(params.modelId ?? "");
        if (calls.length === 1) {
          return { text: "<think>private chain</think>not json", modelId: params.modelId };
        }
        return {
          text:
            "<think>private chain</think>" +
            JSON.stringify({
              groups: [
                {
                  groupId: "sig_test",
                  summary: "Chatfix fallback summary.",
                  recommendedAction: "Keep the recommendation queued for QA proof.",
                  confidence: 0.82,
                },
              ],
            }),
          modelId: params.modelId,
        };
      },
    });

    expect(stripSelfImprovementLlmReasoning("<think>hidden</think>{}")).toBe("{}");
    expect(calls).toEqual([
      "ollama/qwen3.6:27b-q8_0",
      "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
    ]);
    expect(result.status).toMatchObject({
      mode: "local_retry",
      modelTier: "crossCheck",
      groupsReviewedByLocalLlm: 1,
    });
    expect(result.status.attempts).toMatchObject([
      { status: "invalid_json", diagnostic: "no_balanced_json", completionMs: 75 },
      {
        status: "success",
        modelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
        completionMs: 90,
      },
    ]);
    expect(result.status.attempts[0]?.error).toContain(
      "no balanced JSON object or array was found",
    );
    expect(result.groups[0].analysis.summary).toBe("Chatfix fallback summary.");
    expect(result.groups[0].analysis).toMatchObject({
      preflightStatus: "passed",
      preflightMs: 7,
    });
  });

  it("strips common reasoning wrappers from accepted local review fields", async () => {
    expect(
      stripSelfImprovementLlmReasoning(
        "<thinking>private chain</thinking><reasoning>hidden</reasoning><|begin_of_thought|>scratch<|end_of_thought|>{}",
      ),
    ).toBe("{}");
    expect(stripSelfImprovementLlmReasoning("Reasoning: hidden scratch\nFinal: {}")).toBe("{}");

    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: passingPreflight,
      completion: async (params) => ({
        text: JSON.stringify({
          groups: [
            {
              groupId: "sig_test",
              summary:
                "<thinking>private chain</thinking>Use the existing QA route and keep proof required.",
              recommendedAction:
                "[reasoning]hidden rationale[/reasoning]Ask QA to rerun one smoke with attached proof.",
              confidence: 0.82,
              safetyNotes: ["<|begin_of_thought|>internal<|end_of_thought|>No direct merge."],
            },
          ],
        }),
        modelId: params.modelId,
      }),
    });

    expect(result.status).toMatchObject({
      mode: "local_llm",
      schemaValidated: true,
    });
    const analysis = result.groups[0]?.analysis;
    expect(analysis?.summary).toBe("Use the existing QA route and keep proof required.");
    expect(result.groups[0]?.recommendedAction).toBe(
      "Ask QA to rerun one smoke with attached proof. Before resolving, keep the item pending for owner or operator approval.",
    );
    expect(analysis?.safetyNotes).toEqual(["No direct merge."]);
  });

  it("skips scratchpad JSON and applies the first schema-valid review payload", async () => {
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: passingPreflight,
      completion: async (params) => ({
        text:
          '{"scratchpad":"private chain of thought"}\n' +
          JSON.stringify({
            groups: [
              {
                groupId: "sig_test",
                summary: "Recovered the final schema-valid review payload.",
                recommendedAction: "Keep the recommendation pending for owner proof.",
                confidence: 0.84,
              },
            ],
          }),
        modelId: params.modelId,
      }),
    });

    expect(result.status).toMatchObject({
      mode: "local_llm",
      schemaValidated: true,
      groupsReviewedByLocalLlm: 1,
    });
    expect(result.groups[0]?.analysis.summary).toBe(
      "Recovered the final schema-valid review payload.",
    );
    expect(JSON.stringify(result)).not.toContain("private chain of thought");
  });

  it("accepts common local-model JSON shapes without storing reasoning text", async () => {
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: passingPreflight,
      completion: async (params) => ({
        text:
          "analysis follows\n" +
          "<think>private chain</think>" +
          '[{"groupId":"sig_test","summary":"Recovered local summary.","recommendedAction":"Keep the routed QA proposal pending until smoke proof exists.","confidence":0.81,"safetyNotes":["No direct merge."],},]',
        modelId: params.modelId,
      }),
    });

    expect(result.status).toMatchObject({
      mode: "local_llm",
      schemaValidated: true,
      groupsReviewedByLocalLlm: 1,
    });
    expect(result.groups[0].analysis.summary).toBe("Recovered local summary.");
    expect(result.groups[0].analysis.summary).not.toContain("private chain");
    expect(result.groups[0].recommendedAction).toBe(
      "Keep the routed QA proposal pending until smoke proof exists.",
    );
  });

  it("does not count reasoning-only reviewed fields as schema-valid", async () => {
    const calls: string[] = [];
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: passingPreflight,
      completion: async (params) => {
        calls.push(params.modelId ?? "");
        if (calls.length === 1) {
          return {
            text: JSON.stringify({
              groups: [
                {
                  groupId: "sig_test",
                  summary: "Reasoning: private scratch about the evidence",
                  recommendedAction: "Thinking: hidden action rationale",
                  confidence: 0.83,
                },
              ],
            }),
            modelId: params.modelId,
          };
        }
        return {
          text: JSON.stringify({
            groups: [
              {
                groupId: "sig_test",
                summary: "Reasoning: private scratch\nFinal: Safe final local summary.",
                recommendedAction:
                  "Thinking: hidden action rationale\nRecommended action: Keep QA proof required.",
                confidence: 0.83,
                safetyNotes: ["Analysis: hidden scratch\nAnswer: No direct merge."],
              },
            ],
          }),
          modelId: params.modelId,
        };
      },
    });

    expect(calls).toEqual([
      "ollama/qwen3.6:27b-q8_0",
      "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
    ]);
    expect(result.status).toMatchObject({
      mode: "local_retry",
      modelTier: "crossCheck",
      schemaValidated: true,
    });
    expect(result.status.attempts).toMatchObject([
      { status: "invalid_json", schemaValidated: false },
      { status: "success", schemaValidated: true },
    ]);
    expect(result.groups[0]?.analysis.summary).toBe("Safe final local summary.");
    expect(result.groups[0]?.recommendedAction).toBe(
      "Keep QA proof required. Before resolving, keep the item pending for owner or operator approval.",
    );
    expect(result.groups[0]?.analysis.safetyNotes).toEqual(["No direct merge."]);
    expect(JSON.stringify(result)).not.toContain("private scratch");
    expect(JSON.stringify(result)).not.toContain("hidden action rationale");
  });

  it("accepts unambiguous single-group local JSON with alias fields", async () => {
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: passingPreflight,
      completion: async (params) => ({
        text: JSON.stringify({
          recommendations: [
            {
              summary: "Recovered single-group Qwen fallback summary.",
              recommended_action: "Keep the QA proposal pending until smoke proof is attached.",
              confidence: "0.83",
              safety_notes: "No direct merge.",
            },
          ],
        }),
        modelId: params.modelId,
      }),
    });

    expect(result.status).toMatchObject({
      mode: "local_llm",
      schemaValidated: true,
      groupsReviewedByLocalLlm: 1,
    });
    expect(result.groups[0]).toMatchObject({
      recommendedAction: "Keep the QA proposal pending until smoke proof is attached.",
      analysis: {
        summary: "Recovered single-group Qwen fallback summary.",
        confidence: 0.83,
        schemaValidated: true,
      },
    });
    expect(result.groups[0]?.analysis.safetyNotes).toEqual(["No direct merge."]);
  });

  it("accepts object-keyed local review groups with confidence labels", async () => {
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: passingPreflight,
      completion: async (params) => ({
        text: JSON.stringify({
          groups: {
            sig_test: {
              summary: "Recovered object-keyed local summary.",
              recommendation: "Keep the routed QA proposal pending until smoke proof exists.",
              confidence: "high",
              safety: "No direct merge.",
            },
          },
        }),
        modelId: params.modelId,
      }),
    });

    expect(result.status).toMatchObject({
      mode: "local_llm",
      schemaValidated: true,
      groupsReviewedByLocalLlm: 1,
    });
    expect(result.groups[0]).toMatchObject({
      recommendedAction: "Keep the routed QA proposal pending until smoke proof exists.",
      analysis: {
        summary: "Recovered object-keyed local summary.",
        confidence: 0.8,
      },
    });
    expect(result.groups[0]?.analysis.safetyNotes).toEqual(["No direct merge."]);
  });

  it("accepts nested wrappers, action arrays, and percentage confidence", async () => {
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: passingPreflight,
      completion: async (params) => ({
        text: JSON.stringify({
          result: {
            review: {
              recommendations: [
                {
                  group_id: "sig_test",
                  summary: "Recovered nested local reviewer payload.",
                  recommended_next_step: [
                    "Run the focused dashboard smoke through the QA route.",
                    "Attach proof before resolving.",
                  ],
                  confidence: "82%",
                  safety_notes: ["No direct merge."],
                },
              ],
            },
          },
        }),
        modelId: params.modelId,
      }),
    });

    expect(result.status).toMatchObject({
      mode: "local_llm",
      schemaValidated: true,
      groupsReviewedByLocalLlm: 1,
    });
    expect(result.groups[0]).toMatchObject({
      recommendedAction:
        "Run the focused dashboard smoke through the QA route; Attach proof before resolving. Before resolving, keep the item pending for owner or operator approval.",
      analysis: {
        summary: "Recovered nested local reviewer payload.",
        confidence: 0.82,
      },
    });
  });

  it("rejects object-keyed local groups that do not match any input group", async () => {
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: passingPreflight,
      completion: async (params) => ({
        text: JSON.stringify({
          groups: {
            sig_unknown: {
              summary: "Unknown keyed group should not validate.",
              recommendedAction: "Do not apply this unmatched recommendation.",
              confidence: "high",
            },
          },
        }),
        modelId: params.modelId,
      }),
    });

    expect(result.status).toMatchObject({
      mode: "fallback",
      schemaValidated: false,
    });
    expect(result.status.attempts).toMatchObject([
      { tier: "primaryReview", status: "invalid_json", diagnostic: "unmatched_group_id" },
      { tier: "crossCheck", status: "invalid_json", diagnostic: "unmatched_group_id" },
    ]);
    expect(result.status.attempts[0]?.error).toContain("ids that do not match the input groups");
    expect(result.groups[0]?.analysis.mode).toBe("deterministic");
  });

  it("does not infer missing group ids for ambiguous multi-group local JSON", async () => {
    const secondGroup: SelfImprovementRecommendationGroup = {
      ...group(),
      id: "sig_second",
      groupKey: "smoke_failure:task_group:mobile-smoke",
      title: "Mobile smoke failures",
      recommendationIds: ["sir_second"],
    };
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group(), secondGroup],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: passingPreflight,
      completion: async (params) => ({
        text: JSON.stringify({
          groups: [
            {
              summary: "Ambiguous first summary.",
              recommendedAction: "Do not apply without a group id.",
              confidence: 0.8,
            },
            {
              summary: "Ambiguous second summary.",
              recommendedAction: "Do not apply without a group id.",
              confidence: 0.8,
            },
          ],
        }),
        modelId: params.modelId,
      }),
    });

    expect(result.status).toMatchObject({
      mode: "fallback",
      schemaValidated: false,
    });
    expect(result.status.attempts).toMatchObject([
      { tier: "primaryReview", status: "invalid_json", diagnostic: "missing_group_id" },
      { tier: "crossCheck", status: "invalid_json", diagnostic: "missing_group_id" },
    ]);
    expect(result.status.attempts[0]?.error).toContain(
      "omitted groupId values in an ambiguous payload",
    );
    expect(result.groups.map((entry) => entry.analysis.mode)).toEqual([
      "deterministic",
      "deterministic",
    ]);
  });

  it("blocks unavailable local preflight and keeps deterministic analysis", async () => {
    const preflightCalls: string[] = [];
    let completionCalls = 0;
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: async (params) => {
        preflightCalls.push(params.modelId ?? "");
        return {
          ok: false,
          status: "unavailable",
          elapsedMs: 11,
          reason: `${params.modelId} is not reachable`,
        };
      },
      completion: async () => {
        completionCalls += 1;
        return { text: "{}" };
      },
    });

    expect(preflightCalls).toEqual([
      "ollama/qwen3.6:27b-q8_0",
      "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
    ]);
    expect(completionCalls).toBe(0);
    expect(result.status).toMatchObject({
      mode: "fallback",
      schemaValidated: false,
      groupsReviewedByLocalLlm: 0,
    });
    expect(result.status.attempts).toMatchObject([
      {
        tier: "primaryReview",
        status: "blocked",
        preflightStatus: "unavailable",
        preflightMs: 11,
      },
      {
        tier: "crossCheck",
        status: "blocked",
        preflightStatus: "unavailable",
        preflightMs: 11,
      },
    ]);
    expect(result.groups[0].analysis.mode).toBe("deterministic");
  });

  it("blocks default local preflight when local Ollama models are not configured", async () => {
    let completionCalls = 0;
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: async (params) => ({
        ok: false,
        status: "missing_config",
        elapsedMs: 2,
        reason: `Local model preflight could not find ${params.modelId}.`,
      }),
      completion: async () => {
        completionCalls += 1;
        return { text: "{}" };
      },
    });

    expect(completionCalls).toBe(0);
    expect(result.status).toMatchObject({
      mode: "fallback",
      schemaValidated: false,
    });
    expect(result.status.attempts[0]).toMatchObject({
      tier: "primaryReview",
      status: "blocked",
      preflightStatus: "missing_config",
      remediationHint:
        "Verify Ollama is running and the selected local model appears in the local /api/tags catalog, then rerun openclaw self-improvement preflight.",
    });
    expect(result.status.attempts[0]?.error).toContain("ollama/qwen3.6:27b-q8_0");
  });

  it("blocks malformed local provider config without starting generation", async () => {
    let completionCalls = 0;
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: {
        models: {
          mode: "merge",
          providers: {
            "kimi-local": {
              baseUrl: "http://127.0.0.1:8000/v1",
              api: "openai-completions",
            },
          },
        },
      } as unknown as OpenClawConfig,
      now,
      reviewModelId: "kimi-local/moonshotai/Kimi-K2.6",
      fallbackModelId: "kimi-local/moonshotai/Kimi-K2.6",
      completion: async () => {
        completionCalls += 1;
        return { text: "{}" };
      },
    });

    expect(completionCalls).toBe(0);
    expect(result.status).toMatchObject({
      mode: "fallback",
      schemaValidated: false,
    });
    expect(result.status.attempts).toMatchObject([
      {
        tier: "primaryReview",
        status: "blocked",
        preflightStatus: "missing_config",
      },
      {
        tier: "crossCheck",
        status: "blocked",
        preflightStatus: "missing_config",
      },
    ]);
    expect(result.status.attempts[0]?.error).toContain(
      "could not find moonshotai/Kimi-K2.6 in models.providers.kimi-local.models",
    );
  });

  it("blocks default local preflight when provider catalog omits the selected model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ data: [{ id: "moonshotai/Other" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    let completionCalls = 0;
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: configuredKimiCfg(),
      now,
      reviewModelId: "kimi-local/moonshotai/Kimi-K2.6",
      fallbackModelId: "kimi-local/moonshotai/Kimi-K2.6",
      completion: async () => {
        completionCalls += 1;
        return { text: "{}" };
      },
    });

    expect(completionCalls).toBe(0);
    expect(result.status).toMatchObject({
      mode: "fallback",
      schemaValidated: false,
    });
    expect(result.status.attempts).toMatchObject([
      {
        tier: "primaryReview",
        status: "blocked",
        preflightStatus: "missing_config",
      },
      {
        tier: "crossCheck",
        status: "blocked",
        preflightStatus: "missing_config",
      },
    ]);
    expect(result.status.attempts[0]?.error).toContain("was not listed by the provider");
  });

  it("blocks local preflight when the provider response is not a provable model catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }),
    );
    let completionCalls = 0;
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: configuredKimiCfg(),
      now,
      reviewModelId: "kimi-local/moonshotai/Kimi-K2.6",
      fallbackModelId: "kimi-local/moonshotai/Kimi-K2.6",
      completion: async () => {
        completionCalls += 1;
        return { text: "{}" };
      },
    });

    expect(completionCalls).toBe(0);
    expect(result.status).toMatchObject({
      mode: "fallback",
      schemaValidated: false,
    });
    expect(result.status.attempts).toMatchObject([
      {
        tier: "primaryReview",
        status: "blocked",
        preflightStatus: "unavailable",
      },
      {
        tier: "crossCheck",
        status: "blocked",
        preflightStatus: "unavailable",
      },
    ]);
    expect(result.status.attempts[0]?.error).toContain(
      "provider catalog did not prove moonshotai/Kimi-K2.6 is available",
    );
  });

  it("runs explicit external Kimi preflight before a configured responsive Kimi review", async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        fetchCalls.push(String(input));
        return new Response(JSON.stringify({ data: [{ id: "moonshotai/Kimi-K2.6" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: configuredKimiCfg(),
      now,
      reviewModelId: "kimi-local/moonshotai/Kimi-K2.6",
      completion: async (params) => ({
        text: JSON.stringify({
          groups: [
            {
              groupId: "sig_test",
              summary: "Configured local Kimi summary.",
              recommendedAction: "Keep the recommendation queued for owner review.",
              confidence: 0.88,
            },
          ],
        }),
        modelId: params.modelId,
      }),
    });

    expect(fetchCalls).toEqual(["http://127.0.0.1:8000/v1/models"]);
    expect(result.status).toMatchObject({
      mode: "local_llm",
      schemaValidated: true,
      modelTier: "primaryReview",
    });
    expect(result.status.attempts[0]).toMatchObject({
      status: "success",
      preflightStatus: "passed",
      preflightSource: "configured_provider",
      providerConfigured: true,
    });
  });

  it("labels responsive default Ollama reviewers when no explicit provider config exists", async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        fetchCalls.push(String(input));
        return new Response(
          JSON.stringify({
            models: [
              { name: "qwen3.6:27b-q8_0" },
              { name: "openclaw-control-qwen3-30b-q6-chatfix:latest" },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    const result = await preflightSelfImprovementReviewModels({
      cfg: {} as OpenClawConfig,
      localFirst: true,
      checkedAt: now,
    });

    expect(fetchCalls).toEqual([
      "http://127.0.0.1:11434/api/tags",
      "http://127.0.0.1:11434/api/tags",
    ]);
    expect(result).toMatchObject({
      ready: true,
      readiness: "ready",
      readyTier: "primaryReview",
      readyModelId: "ollama/qwen3.6:27b-q8_0",
    });
    expect(result.attempts).toMatchObject([
      {
        tier: "primaryReview",
        status: "success",
        preflightStatus: "passed",
        preflightSource: "default_ollama",
        providerConfigured: false,
      },
      {
        tier: "crossCheck",
        status: "success",
        preflightStatus: "passed",
        preflightSource: "default_ollama",
        providerConfigured: false,
      },
    ]);
  });

  it("caches failed local endpoint preflight probes for repeated local-first checks", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connect refused");
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await preflightSelfImprovementReviewModels({
      cfg: configuredKimiCfg(),
      localFirst: true,
      reviewModelId: "kimi-local/moonshotai/Kimi-K2.6",
      fallbackModelId: "kimi-local/moonshotai/Kimi-K2.6",
      checkedAt: now,
    });
    const second = await preflightSelfImprovementReviewModels({
      cfg: configuredKimiCfg(),
      localFirst: true,
      reviewModelId: "kimi-local/moonshotai/Kimi-K2.6",
      fallbackModelId: "kimi-local/moonshotai/Kimi-K2.6",
      checkedAt: now + 1_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      ready: false,
      readiness: "blocked",
      preflightStatus: "unavailable",
    });
    expect(second).toMatchObject({
      ready: false,
      readiness: "blocked",
      preflightStatus: "unavailable",
    });
    expect(second.attempts).toMatchObject([
      { tier: "primaryReview", status: "blocked", preflightStatus: "unavailable" },
      { tier: "crossCheck", status: "blocked", preflightStatus: "unavailable" },
    ]);
    expect(JSON.stringify(second)).not.toContain("local-openclaw");
  });

  it("blocks public hosted provider base URLs in local-first review slots before fetch", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should not run for public hosted local-first reviewers");
    });
    vi.stubGlobal("fetch", fetchMock);
    let completionCalls = 0;
    const cfg: OpenClawConfig = {
      models: {
        mode: "merge",
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com/v1",
            apiKey: "secret-marker",
            api: "anthropic-messages",
            models: [
              {
                id: "claude-4.6",
                name: "Claude 4.6",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    };

    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      reviewModelId: "anthropic/claude-4.6",
      fallbackModelId: "anthropic/claude-4.6",
      cfg,
      now,
      completion: async () => {
        completionCalls += 1;
        return { text: "{}" };
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(completionCalls).toBe(0);
    expect(result.status).toMatchObject({
      mode: "fallback",
      schemaValidated: false,
    });
    expect(result.status.attempts).toMatchObject([
      { tier: "primaryReview", status: "blocked", preflightStatus: "missing_config" },
      { tier: "crossCheck", status: "blocked", preflightStatus: "missing_config" },
    ]);
    expect(result.status.attempts[0]?.error).toContain("Use hosted escalation gates");
    expect(JSON.stringify(result)).not.toContain("secret-marker");
  });

  it("allows trusted self-hosted local model hostnames with private-network approval", async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        fetchCalls.push(String(input));
        return new Response(JSON.stringify({ data: [{ id: "local-reviewer" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const cfg: OpenClawConfig = {
      models: {
        mode: "merge",
        providers: {
          "gpu-box": {
            baseUrl: "http://gpu-box.local:8000/v1",
            apiKey: "local-openclaw",
            api: "openai-completions",
            request: { allowPrivateNetwork: true },
            models: [
              {
                id: "local-reviewer",
                name: "Local Reviewer",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262_144,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    };

    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      reviewModelId: "gpu-box/local-reviewer",
      cfg,
      now,
      completion: async (params) => ({
        text: JSON.stringify({
          groups: [
            {
              groupId: "sig_test",
              summary: "Trusted local reviewer produced bounded output.",
              recommendedAction: "Keep the routed recommendation pending for verified proof.",
              confidence: 0.8,
            },
          ],
        }),
        modelId: params.modelId,
      }),
    });

    expect(fetchCalls).toEqual(["http://gpu-box.local:8000/v1/models"]);
    expect(result.status).toMatchObject({
      mode: "local_llm",
      modelTier: "primaryReview",
      schemaValidated: true,
    });
    expect(result.status.attempts[0]).toMatchObject({
      status: "success",
      preflightStatus: "passed",
    });
  });

  it("preflights local-first review models without generation", async () => {
    const calls: string[] = [];
    const result = await preflightSelfImprovementReviewModels({
      cfg: {} as OpenClawConfig,
      localFirst: true,
      checkedAt: now,
      preflight: async (params) => {
        calls.push(params.modelId ?? "");
        return {
          ok: false,
          status: "missing_config",
          elapsedMs: 2,
          reason: `${params.modelId} is not configured`,
        };
      },
    });

    expect(calls).toEqual([
      "ollama/qwen3.6:27b-q8_0",
      "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
    ]);
    expect(result).toMatchObject({
      checkedAt: now,
      ready: false,
      readiness: "blocked",
      reviewPolicy: "local_first",
      reviewModelId: "ollama/qwen3.6:27b-q8_0",
      fallbackModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      strategicModelId: "ollama/openclaw-strategic-qwen3-235b:latest",
      localFirst: true,
      schemaValidated: false,
      preflightStatus: "missing_config",
      preflightMs: 4,
      blockedPrimaryReason: "ollama/qwen3.6:27b-q8_0 is not configured",
    });
    expect(result.attempts).toMatchObject([
      { tier: "primaryReview", status: "blocked", preflightStatus: "missing_config" },
      { tier: "crossCheck", status: "blocked", preflightStatus: "missing_config" },
    ]);
  });

  it("preflights strategic local routing only when explicitly allowed", async () => {
    const calls: string[] = [];
    const result = await preflightSelfImprovementReviewModels({
      cfg: {} as OpenClawConfig,
      localFirst: true,
      strategic: true,
      allowStrategicLocal: true,
      checkedAt: now,
      preflight: async (params) => {
        calls.push(params.modelId ?? "");
        return {
          ok: true,
          status: "passed",
          elapsedMs: 3,
        };
      },
    });

    expect(calls).toEqual([
      "ollama/qwen3.6:27b-q8_0",
      "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      "ollama/openclaw-strategic-qwen3-235b:latest",
    ]);
    expect(result).toMatchObject({
      ready: true,
      readiness: "ready",
      readyTier: "primaryReview",
      readyModelId: "ollama/qwen3.6:27b-q8_0",
      reviewPolicy: "local_first",
      strategicRequested: true,
      strategicLocalAllowed: true,
      escalationReason: "major-change or critical self-improvement group",
      preflightStatus: "passed",
    });
    expect(result.attempts).toMatchObject([
      {
        tier: "primaryReview",
        status: "success",
        modelId: "ollama/qwen3.6:27b-q8_0",
      },
      {
        tier: "crossCheck",
        status: "success",
        modelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      },
      {
        tier: "strategic",
        status: "success",
        modelId: "ollama/openclaw-strategic-qwen3-235b:latest",
      },
    ]);
  });

  it("marks model preflight degraded when Qwen primary is blocked but chatfix fallback is ready", async () => {
    const result = await preflightSelfImprovementReviewModels({
      cfg: {} as OpenClawConfig,
      localFirst: true,
      checkedAt: now,
      preflight: async (params) => {
        if (params.modelId === "ollama/qwen3.6:27b-q8_0") {
          return {
            ok: false,
            status: "missing_config",
            elapsedMs: 2,
            reason: "Local model preflight could not find qwen3.6:27b-q8_0.",
          };
        }
        return {
          ok: true,
          status: "passed",
          elapsedMs: 5,
        };
      },
    });

    expect(result).toMatchObject({
      ready: true,
      readiness: "degraded",
      readyTier: "crossCheck",
      readyModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      preflightStatus: "missing_config",
      preflightMs: 7,
      blockedPrimaryReason: "Local model preflight could not find qwen3.6:27b-q8_0.",
    });
    expect(result.attempts).toMatchObject([
      {
        tier: "primaryReview",
        status: "blocked",
        preflightStatus: "missing_config",
        remediationHint:
          "Verify Ollama is running and the selected local model appears in the local /api/tags catalog, then rerun openclaw self-improvement preflight.",
      },
      { tier: "crossCheck", status: "success", preflightStatus: "passed" },
    ]);
  });

  it("keeps hosted preflight blocked without explicit hosted escalation allowance", async () => {
    const result = await preflightSelfImprovementReviewModels({
      cfg: {} as OpenClawConfig,
      requested: true,
      approved: true,
      localFirst: false,
      env: { OPENCLAW_SELF_IMPROVEMENT_LLM: "1" },
      checkedAt: now,
      preflight: passingPreflight,
    });

    expect(result).toMatchObject({
      ready: false,
      readiness: "blocked",
      reviewPolicy: "hosted",
      hostedEscalationAllowed: false,
      hostedModelId: "openai/gpt-5.5",
      localFirst: false,
      schemaValidated: false,
    });
    expect(result.attempts).toMatchObject([
      {
        tier: "hostedEscalation",
        status: "blocked",
        local: false,
      },
    ]);
    expect(result.fallbackReason).toContain("explicit hosted escalation allowance");
  });

  it("keeps hosted preflight blocked without approval and env gate", async () => {
    const result = await preflightSelfImprovementReviewModels({
      cfg: {} as OpenClawConfig,
      requested: true,
      allowHostedEscalation: true,
      approved: false,
      localFirst: false,
      env: {},
      checkedAt: now,
      preflight: passingPreflight,
    });

    expect(result).toMatchObject({
      ready: false,
      readiness: "blocked",
      reviewPolicy: "hosted",
      hostedModelId: "openai/gpt-5.5",
      localFirst: false,
      schemaValidated: false,
    });
    expect(result.attempts).toMatchObject([
      {
        tier: "hostedEscalation",
        status: "blocked",
        local: false,
      },
    ]);
    expect(result.fallbackReason).toContain("explicit per-run approval");
  });

  it("rejects schema-incomplete local JSON before deterministic fallback", async () => {
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: passingPreflight,
      completion: async (params) => ({
        text: JSON.stringify({ groups: [{ groupId: "sig_test" }] }),
        modelId: params.modelId,
      }),
    });

    expect(result.status).toMatchObject({
      mode: "fallback",
      schemaValidated: false,
    });
    expect(result.status.attempts).toMatchObject([
      {
        tier: "primaryReview",
        status: "invalid_json",
        diagnostic: "missing_required_fields",
        preflightStatus: "passed",
      },
      {
        tier: "crossCheck",
        status: "invalid_json",
        diagnostic: "missing_required_fields",
        preflightStatus: "passed",
      },
    ]);
    expect(result.groups[0].analysis.summary).toBe("One recommendation is ready.");
  });

  it("keeps local readiness degraded instead of blocked when chatfix is reachable but invalid", async () => {
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: async (params) => {
        if (params.modelId === "ollama/qwen3.6:27b-q8_0") {
          return {
            ok: false,
            status: "missing_config",
            elapsedMs: 2,
            reason: "Local model preflight could not find qwen3.6:27b-q8_0.",
          };
        }
        return {
          ok: true,
          status: "passed",
          elapsedMs: 5,
        };
      },
      completion: async (params) => ({
        text: "<think>scratch</think>not json",
        modelId: params.modelId,
      }),
    });

    expect(result.status).toMatchObject({
      mode: "fallback",
      schemaValidated: false,
    });
    expect(result.status.attempts).toMatchObject([
      {
        tier: "primaryReview",
        status: "blocked",
        preflightStatus: "missing_config",
      },
      {
        tier: "crossCheck",
        status: "invalid_json",
        preflightStatus: "passed",
        diagnostic: "no_balanced_json",
      },
    ]);
    expect(summarizeSelfImprovementModelReadiness(result.status.attempts)).toMatchObject({
      ready: true,
      readiness: "degraded",
      readyTier: "crossCheck",
      readyModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      blockedPrimaryReason: "Local model preflight could not find qwen3.6:27b-q8_0.",
    });
  });

  it("uses strategic Qwen review only after primary and fallback fail for major-change groups", async () => {
    const strategicGroup: SelfImprovementRecommendationGroup = {
      ...group(),
      category: "major_change",
      criticality: "critical",
      priority: "critical",
    };
    const calls: string[] = [];
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [strategicGroup],
      requested: false,
      localFirst: true,
      allowStrategicLocal: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: passingPreflight,
      completion: async (params) => {
        calls.push(params.modelId ?? "");
        if (calls.length < 3) {
          return { text: "<think>scratch</think>not json", modelId: params.modelId };
        }
        return {
          text: JSON.stringify({
            groups: [
              {
                groupId: "sig_test",
                summary: "Strategic model summary.",
                recommendedAction: "Draft a major-change proposal with explicit gates.",
                confidence: 0.86,
              },
            ],
          }),
          modelId: params.modelId,
        };
      },
    });

    expect(calls).toEqual([
      "ollama/qwen3.6:27b-q8_0",
      "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      "ollama/openclaw-strategic-qwen3-235b:latest",
    ]);
    expect(result.status).toMatchObject({
      mode: "strategic_local",
      modelTier: "strategic",
      escalationReason: "major-change or critical self-improvement group",
    });
    expect(result.status.attempts).toMatchObject([
      {
        tier: "primaryReview",
        status: "invalid_json",
        diagnostic: "no_balanced_json",
      },
      {
        tier: "crossCheck",
        status: "invalid_json",
        diagnostic: "no_balanced_json",
      },
      {
        tier: "strategic",
        status: "success",
        quantization: "Ollama local",
        parameters: "235B",
      },
    ]);
  });

  it("blocks hosted escalation without explicit approval after local failures", async () => {
    let calls = 0;
    const result = await reviewSelfImprovementGroupsWithLlm({
      groups: [group()],
      requested: false,
      localFirst: true,
      allowHostedEscalation: true,
      cfg: {} as OpenClawConfig,
      now,
      preflight: passingPreflight,
      completion: async () => {
        calls += 1;
        throw new Error("model unavailable");
      },
    });

    expect(calls).toBe(2);
    expect(result.status).toMatchObject({
      mode: "fallback",
      schemaValidated: false,
    });
    expect(result.status.attempts).toMatchObject([
      { tier: "primaryReview", status: "failed" },
      { tier: "crossCheck", status: "failed" },
      { tier: "hostedEscalation", status: "blocked" },
    ]);
  });
});
