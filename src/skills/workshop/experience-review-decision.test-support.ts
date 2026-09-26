import type { AgentMessage } from "@openclaw/agent-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import { isToolResultError } from "../../agents/tool-result-error.js";
import {
  prepareToolSearchDispatcherArguments,
  readToolSearchCallArgs,
} from "../../agents/tool-search-request.js";
import type { readSkillCuratorReviewStatus } from "./collection-review-state.test-support.js";
import { readExperienceReviewMessageText } from "./experience-review-message-text.test-support.js";
import type { observeExperienceReview } from "./experience-review-observation.test-support.js";
import type { getSkillProposalRunProgress } from "./proposal-run-progress.test-support.js";
import type { listSkillProposals } from "./service.js";

export function assertExperienceReviewDecision(params: {
  observation: Awaited<ReturnType<typeof observeExperienceReview>>;
  messages: AgentMessage[];
  progress: Awaited<ReturnType<typeof getSkillProposalRunProgress>>;
  proposals: readonly Pick<
    Awaited<ReturnType<typeof listSkillProposals>>["proposals"][number],
    "id" | "status"
  >[];
  outcome: ReturnType<typeof readSkillCuratorReviewStatus>["experienceReviews"][string] | undefined;
  startedAt: number;
}): "proposed" | "abstained" {
  const { observation, progress, proposals, outcome } = params;
  expect(observation.requests[0]?.toolNames).toEqual(
    expect.arrayContaining(["exec", "read", "tool_search", "tool_describe", "tool_call"]),
  );
  expect(observation.requests[0]?.toolNames).not.toContain("skill_workshop");
  expect(observation.requests[0]?.systemPrompt).toMatch(
    /^- skill_workshop(?: \([^\n)]+\))?(?::|$)/m,
  );
  expect(observation.requests[0]?.outputs).toEqual(
    params.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => readExperienceReviewMessageText(message.content)),
  );
  expect(outcome?.attemptedAtMs).toBeGreaterThanOrEqual(params.startedAt);
  expect(outcome?.usage?.outputTokens).toBeGreaterThan(0);
  expect(observation.toolResults.some((result) => result.isError)).toBe(false);
  const workshopCalls = observation.toolCalls.flatMap((call) => {
    const receipts = observation.toolResults.filter(
      (result) => result.toolName === call.name && result.toolCallId === call.id,
    );
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0];
    expect(receipt).toMatchObject({ isError: false });
    if (call.name === "tool_search" || call.name === "tool_describe") {
      return [];
    }
    // Foreground coding schemas remain for replay, but draft-only reviews gate their execution.
    expect(call.name).toBe("tool_call");
    const envelope = receipt?.details;
    if (
      !isRecord(envelope) ||
      !isRecord(envelope.tool) ||
      !isRecord(envelope.result) ||
      !isRecord(envelope.result.details) ||
      !Array.isArray(envelope.result.content)
    ) {
      throw new Error("Workshop call is missing its result envelope.");
    }
    expect(envelope.tool).toMatchObject({
      id: expect.any(String),
      name: "skill_workshop",
      source: "openclaw",
    });
    expect(envelope.result.isError).not.toBe(true);
    expect(isToolResultError(envelope.result)).toBe(false);
    const toolArguments = observation.toolArguments.find((entry) => entry.toolCallId === call.id);
    if (!toolArguments) {
      throw new Error("Workshop call is missing its validated arguments.");
    }
    expect(toolArguments.prepared).toEqual(prepareToolSearchDispatcherArguments(call.arguments));
    const dispatched = readToolSearchCallArgs(toolArguments.validated);
    if (!isRecord(dispatched.input)) {
      throw new Error("Workshop call is missing its target arguments.");
    }
    expect([envelope.tool.id, envelope.tool.name]).toContain(dispatched.id);
    return [
      {
        input: dispatched.input,
        details: envelope.result.details,
        text: envelope.result.content
          .flatMap((part: unknown) =>
            isRecord(part) && part.type === "text" && typeof part.text === "string"
              ? [part.text]
              : [],
          )
          .join("\n"),
      },
    ];
  });
  const mutations = workshopCalls.filter((call) =>
    ["create", "patch", "update", "revise"].includes(String(call.input.action)),
  );
  if (progress.mutationCount === 0) {
    expect(mutations).toHaveLength(0);
    for (const call of workshopCalls) {
      expect(call.input.action).toSatisfy(
        (action: unknown) =>
          action === "list" ||
          action === "inspect" ||
          action === "read" ||
          action === "prepare_patch",
      );
    }
    expect(progress.proposalIds).toEqual([]);
    expect(observation.finalText).toBe("NO_REPLY");
    expect(outcome?.outcome).toBe("nothing");
    return "abstained";
  }
  expect(progress.mutationCount).toBe(1);
  expect(progress.proposalIds).toHaveLength(1);
  expect(mutations).toHaveLength(1);
  const proposalId = progress.proposalIds[0]!;
  expect(proposals).toContainEqual(expect.objectContaining({ id: proposalId, status: "pending" }));
  expect(mutations[0]!.details).toMatchObject({ id: proposalId, status: "pending" });
  expect(mutations[0]!.text).toContain(proposalId);
  expect(outcome).toMatchObject({ outcome: "proposed", proposalId });
  return "proposed";
}
