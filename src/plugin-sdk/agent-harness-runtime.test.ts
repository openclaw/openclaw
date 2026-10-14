/**
 * Tests agent harness runtime helpers and task dispatch behavior.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  agentHarnessStructuredInput,
  attachModelProviderRequestTransport,
  buildAgentHarnessUserInputAnswers,
  classifyAgentHarnessTerminalOutcome,
  deliverAgentHarnessUserInputPrompt,
  formatAgentHarnessUserInputPrompt,
  getModelProviderRequestTransport,
  queueAgentHarnessMessage,
  setActiveEmbeddedRun,
  type AgentHarness,
  type AgentHarnessQuestionGatewayCall,
  type AgentHarnessAttemptParams,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessSideQuestionParams,
  type AgentHarnessSideQuestionParamsV2,
  type AgentHarnessSessionForkParams,
  type AgentHarnessV2,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptParamsV2,
} from "./agent-harness-runtime.js";

describe("classifyAgentHarnessTerminalOutcome", () => {
  function classify(overrides: Partial<Parameters<typeof classifyAgentHarnessTerminalOutcome>[0]>) {
    return classifyAgentHarnessTerminalOutcome({
      assistantTexts: [],
      reasoningText: "",
      planText: "",
      promptError: null,
      turnCompleted: true,
      ...overrides,
    });
  }

  it("does not classify deliberate silent replies such as NO_REPLY", () => {
    expect(classify({ assistantTexts: ["NO_REPLY"] })).toBeUndefined();
  });

  it("treats whitespace-only assistant text as not visible", () => {
    expect(classify({ assistantTexts: ["  ", "\n\t"] })).toBe("empty");
  });

  it("prefers planning-only when both plan and reasoning text are present", () => {
    expect(
      classify({
        reasoningText: "I need to inspect the files.",
        planText: "I will inspect, patch, and test.",
      }),
    ).toBe("planning-only");
  });

  it("classifies a completed turn with reasoning text only as reasoning-only", () => {
    expect(classify({ reasoningText: "The answer depends on the current repository state." })).toBe(
      "reasoning-only",
    );
  });
});

describe("agent harness runtime SDK facade", () => {
  it("exposes structured input through one frozen named runtime surface", () => {
    expect(Object.isFrozen(agentHarnessStructuredInput)).toBe(true);
    expect(Object.keys(agentHarnessStructuredInput).toSorted()).toEqual([
      "compileForm",
      "compileQuestions",
      "compileUrl",
      "isRecord",
      "run",
      "snapshot",
    ]);
  });

  it("keeps legacy harness implementations source-compatible while requiring capabilities in V2", () => {
    type SessionForkParamsV2 = Parameters<NonNullable<AgentHarnessV2["sessionForkV2"]>["fork"]>[0];
    const legacyHarness = {
      id: "legacy-test",
      label: "Legacy test harness",
      supports: () => ({ supported: true as const, priority: 1 }),
      runAttempt: async (_params: AgentHarnessAttemptParams) => {
        throw new Error("type-only legacy harness");
      },
      runSideQuestion: async (_params: AgentHarnessSideQuestionParams) => ({ text: "legacy" }),
    } satisfies AgentHarness;

    expectTypeOf(legacyHarness).toMatchTypeOf<AgentHarness>();
    expectTypeOf<AgentHarnessV2>().toMatchTypeOf<AgentHarness>();
    expectTypeOf<
      Omit<AgentHarnessSideQuestionParams, "hostCapabilities">
    >().toMatchTypeOf<AgentHarnessSideQuestionParams>();
    expectTypeOf<
      Omit<AgentHarnessAttemptParams, "hostCapabilities">
    >().toMatchTypeOf<AgentHarnessAttemptParams>();
    expectTypeOf<
      Omit<EmbeddedRunAttemptParams, "hostCapabilities">
    >().toMatchTypeOf<EmbeddedRunAttemptParams>();
    expectTypeOf<
      Omit<AgentHarnessAttemptParamsV2, "hostCapabilities"> extends AgentHarnessAttemptParamsV2
        ? true
        : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Omit<EmbeddedRunAttemptParamsV2, "hostCapabilities"> extends EmbeddedRunAttemptParamsV2
        ? true
        : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Omit<
        AgentHarnessSideQuestionParamsV2,
        "hostCapabilities"
      > extends AgentHarnessSideQuestionParamsV2
        ? true
        : false
    >().toEqualTypeOf<false>();

    expectTypeOf<
      Omit<SessionForkParamsV2, "assertCurrent">
    >().toEqualTypeOf<AgentHarnessSessionForkParams>();
    expectTypeOf<
      Omit<SessionForkParamsV2, "assertCurrent"> extends SessionForkParamsV2 ? true : false
    >().toEqualTypeOf<false>();

    // v2026.8.1 queue/register callers need neither a source predicate nor V2.
    type QueueOptions = Parameters<typeof queueAgentHarnessMessage>[2];
    const legacyInjection = {
      isAvailable: () => true,
      queueMessage: async (_text: string, _options?: QueueOptions) => {},
    };
    const legacyHandle = {
      queueMessage: legacyInjection.queueMessage,
      messageInjection: legacyInjection,
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    } satisfies Parameters<typeof setActiveEmbeddedRun>[1];
    expectTypeOf(legacyHandle).toMatchTypeOf<Parameters<typeof setActiveEmbeddedRun>[1]>();
    expectTypeOf(queueAgentHarnessMessage).returns.toEqualTypeOf<boolean>();
    type GuardedInjection = NonNullable<
      Parameters<typeof setActiveEmbeddedRun>[1]["messageInjectionV2"]
    >;
    expectTypeOf<Parameters<GuardedInjection["queueMessage"]>[2]>().toEqualTypeOf<() => void>();
    expectTypeOf<Parameters<GuardedInjection["queueMessage"]>[3]>().toEqualTypeOf<
      "run" | "source-bound"
    >();
    expectTypeOf<Parameters<GuardedInjection["queueMessage"]>["length"]>().toEqualTypeOf<4>();
  });

  it("keeps legacy question callbacks and requires explicit guarded dispatch authority", () => {
    type Legacy = (
      method: string,
      opts: { timeoutMs?: number },
      params?: unknown,
      extra?: { signal?: AbortSignal },
    ) => Promise<unknown>;
    expectTypeOf<AgentHarnessQuestionGatewayCall>().toEqualTypeOf<Legacy>();
    type Override = Parameters<typeof agentHarnessStructuredInput.run>[0]["gatewayCall"];
    expectTypeOf<Legacy>().toMatchTypeOf<Override>();
    expectTypeOf<undefined>().toMatchTypeOf<Override>();
    type Dispatcher = Exclude<Override, Legacy | undefined>;
    type Request = Parameters<Dispatcher["call"]>[0];
    type Protected = Extract<Request["authority"], { kind: "source-bound" }>;
    expectTypeOf<Dispatcher["version"]>().toEqualTypeOf<2>();
    expectTypeOf<Protected["assertCurrent"]>().toEqualTypeOf<() => void>();
    expectTypeOf<Omit<Protected, "assertCurrent">>().not.toMatchTypeOf<Protected>();
  });

  it("exposes attached model request transport metadata helpers", () => {
    const model = attachModelProviderRequestTransport(
      { id: "gpt-test", provider: "custom-openai" },
      { auth: { mode: "header", headerName: "x-api-key", value: "secret" } },
    );

    expect(getModelProviderRequestTransport(model)).toEqual({
      auth: { mode: "header", headerName: "x-api-key", value: "secret" },
    });
  });
});

describe("agent harness user input helpers", () => {
  it("formats prompts and delivers through blocking replies first", async () => {
    const onBlockReply = vi.fn();

    await deliverAgentHarnessUserInputPrompt(
      { onBlockReply },
      [
        {
          id: "mode",
          header: "Mode",
          question: "Pick a mode",
          isOther: true,
          options: [{ label: "Deep", description: "Use more context" }],
        },
      ],
      { intro: "Runtime needs input:" },
    );

    expect(onBlockReply).toHaveBeenCalledWith({
      text: [
        "Runtime needs input:",
        "",
        "Mode",
        "Pick a mode",
        "1. Deep - Use more context",
        "Other: reply with your own answer.",
      ].join("\n"),
    });
  });

  it("keeps a comma-containing option label as one multi-select answer", () => {
    expect(
      buildAgentHarnessUserInputAnswers(
        [
          {
            id: "region",
            header: "Region",
            question: "Which region should deploy?",
            multiSelect: true,
            isOther: true,
            options: [{ label: "Frankfurt, Germany" }, { label: "Dublin, Ireland" }],
          },
        ],
        "Frankfurt, Germany",
      ),
    ).toEqual({ answers: { region: { answers: ["Frankfurt, Germany"] } } });
  });

  it("supports runtime-specific text formatting", () => {
    expect(
      formatAgentHarnessUserInputPrompt(
        [
          {
            id: "answer",
            header: "Header",
            question: "a < b",
          },
        ],
        { formatText: (text) => text.replaceAll("<", "&lt;") },
      ),
    ).toContain("a &lt; b");
  });

  it("preserves blank fallback lines so skipped answers stay aligned", () => {
    expect(
      buildAgentHarnessUserInputAnswers(
        [
          { id: "q1", header: "Q1", question: "First?" },
          { id: "q2", header: "Q2", question: "Second?" },
          { id: "q3", header: "Q3", question: "Third?" },
        ],
        "\nyes\nno",
      ),
    ).toEqual({
      answers: {
        q1: { answers: [] },
        q2: { answers: ["yes"] },
        q3: { answers: ["no"] },
      },
    });
  });
});
