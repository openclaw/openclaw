import { describe, expect, it } from "vitest";
import {
  inferCronProviderTarget,
  resolveCronProviderRouting,
  resolveCronProviderTargetModelRef,
} from "./provider-routing.js";

describe("cron provider routing", () => {
  it("infers gemini for research-heavy cron jobs", () => {
    const inferred = inferCronProviderTarget({
      agentId: "leo",
      name: "leo-nightly-research",
      description: "Produce one strategy research artifact",
      payload: {
        kind: "agentTurn",
        message: "Do deep research with web_search and summarize market signals.",
      },
    });

    expect(inferred).toMatchObject({
      providerTarget: "gemini",
    });
  });

  it("infers claude for refactor/lint review work", () => {
    const inferred = inferCronProviderTarget({
      agentId: "storie",
      name: "docs-and-canon-review",
      description: "Review canon drift and clean up docs",
      payload: {
        kind: "agentTurn",
        message: "Refactor the note structure, fix lint-like docs drift, and review contradictions.",
      },
    });

    expect(inferred).toMatchObject({
      providerTarget: "claude",
    });
  });

  it("infers codex for implementation-heavy maintenance work", () => {
    const inferred = inferCronProviderTarget({
      agentId: "cody",
      name: "feature-backlog-dispatch",
      description: "Dispatch implementation backlog",
      payload: {
        kind: "agentTurn",
        message: "Implement one feature, fix test coverage gaps, and scan the repo backlog.",
      },
    });

    expect(inferred).toMatchObject({
      providerTarget: "codex",
    });
  });

  it("prefers explicit pacing metadata over inference", () => {
    const routing = resolveCronProviderRouting({
      job: {
        agentId: "leo",
        name: "leo-nightly-research",
        description: "Produce one strategy research artifact",
        pacing: { providerTarget: "claude", role: "maintenance" },
        payload: {
          kind: "agentTurn",
          message: "Do deep research with web_search and summarize market signals.",
        },
      },
      provider: "anthropic",
      model: "claude-opus-4-6",
    });

    expect(routing).toMatchObject({
      providerTarget: "claude",
      source: "explicit",
      modelRef: "anthropic/claude-opus-4-6",
    });
  });

  it("prefers a configured gemini-family allowlist model when current model is not gemini", () => {
    expect(
      resolveCronProviderTargetModelRef({
        providerTarget: "gemini",
        provider: "anthropic",
        model: "claude-opus-4-6",
        configuredModelRefs: [
          "anthropic/claude-opus-4-6",
          "blockrun/google/gemini-3.1-pro",
          "blockrun/google/gemini-3-flash-preview",
        ],
      }),
    ).toBe("blockrun/google/gemini-3.1-pro");
  });

  it("falls back to the gemini default model when no configured gemini-family model exists", () => {
    expect(
      resolveCronProviderTargetModelRef({
        providerTarget: "gemini",
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    ).toBe("google/gemini-3.1-pro-preview");
  });
});
