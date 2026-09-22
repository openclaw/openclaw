import { afterEach, expect, it } from "vitest";
import {
  clearAgentRunContext,
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
  resetAgentRunRegistryForTest,
} from "../infra/agent-run-registry.js";
import {
  captureAgentRunProviderReview,
  readAgentRunProviderReview,
} from "./provider-review-terminal.js";
import { createSessionProviderReview } from "./provider-review.js";

afterEach(() => resetAgentRunRegistryForTest());

const target = {
  agentId: "main",
  sessionKey: "agent:main:dashboard:incognito-test",
  sessionId: "incognito-session",
  storePath: ":memory:",
  lifecycleRevision: "revision",
};

function capture(assertSourceCurrent = () => {}) {
  registerAgentRunContext("incognito-run", {
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
    lifecycleGeneration: getAgentRunLifecycleGeneration(),
    lifecycleStartedAt: 1,
    assertSourceCurrent,
  });
  const review = createSessionProviderReview({
    sessionId: target.sessionId,
    refusal: {
      runId: "incognito-run",
      provider: "openai",
      model: "gpt-5.6-sol",
      runtimeId: "codex",
      review: {
        explanation: "Review the pending operation.",
        continuation: { message: "/literal continuation" },
      },
    },
  });
  captureAgentRunProviderReview({
    runId: "incognito-run",
    target,
    review,
    expectedWriterRunId: "incognito-run",
    assertCurrent: assertSourceCurrent,
  });
  return review;
}

it("carries incognito findings through its exact run owner without serializing them", () => {
  const review = capture();
  expect(readAgentRunProviderReview("incognito-run")?.review).toEqual(review);
  expect(JSON.stringify(getAgentRunContext("incognito-run"))).not.toContain("pending operation");
  expect(Object.keys(getAgentRunContext("incognito-run")!)).not.toContain("providerReviewTerminal");
});

it("revokes a retained fact after same-ID run replacement", () => {
  capture();
  const fact = readAgentRunProviderReview("incognito-run");
  clearAgentRunContext("incognito-run");
  registerAgentRunContext("incognito-run", {
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
  });
  expect(readAgentRunProviderReview("incognito-run")).toBeUndefined();
  expect(() => fact?.assertCurrent()).toThrow("ownership changed");
});

it("keeps source revocation effective after the runtime captures its terminal fact", () => {
  let current = true;
  capture(() => {
    if (!current) {
      throw new Error("source revoked");
    }
  });
  current = false;
  expect(() => readAgentRunProviderReview("incognito-run")).toThrow("source revoked");
});
