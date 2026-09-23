import type { AgentMessage } from "@openclaw/agent-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import type { readSkillCuratorReviewStatus } from "./collection-review-state.js";
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
  expect(observation.requests[0]?.outputs).toEqual(
    params.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => readExperienceReviewMessageText(message.content)),
  );
  expect(outcome?.attemptedAtMs).toBeGreaterThanOrEqual(params.startedAt);
  expect(outcome?.usage?.outputTokens).toBeGreaterThan(0);
  expect(observation.toolResults.some((result) => result.isError)).toBe(false);
  const workshopCalls: Array<{ action: unknown; receiptText: string }> = [];
  for (const call of observation.toolCalls) {
    expect(["tool_search", "tool_describe", "tool_call"]).toContain(call.name);
    const receipt = observation.toolResults.find(
      (result) => result.toolName === call.name && result.toolCallId === call.id,
    );
    expect(receipt).toMatchObject({ isError: false });
    if (call.name !== "tool_call") {
      continue;
    }
    if (!receipt || !isRecord(call.arguments) || !isRecord(call.arguments.args)) {
      throw new Error("Workshop dispatch requires arguments and a matching receipt");
    }
    const envelope: unknown = JSON.parse(readExperienceReviewMessageText(receipt.content));
    if (!isRecord(envelope) || !isRecord(envelope.tool) || !isRecord(envelope.result)) {
      throw new Error("Workshop dispatch did not return its canonical target receipt");
    }
    expect(envelope.tool).toMatchObject({ name: "skill_workshop", source: "openclaw" });
    expect(typeof call.arguments.id).toBe("string");
    expect(call.arguments.id === envelope.tool.id || call.arguments.id === envelope.tool.name).toBe(
      true,
    );
    expect(envelope.result.isError).not.toBe(true);
    if (!Array.isArray(envelope.result.content)) {
      throw new Error("Workshop target receipt did not retain its result content");
    }
    workshopCalls.push({
      action: call.arguments.args.action,
      receiptText: envelope.result.content
        .flatMap((part: unknown) =>
          isRecord(part) && part.type === "text" && typeof part.text === "string"
            ? [part.text]
            : [],
        )
        .join("\n"),
    });
  }
  const mutations = workshopCalls.filter((call) =>
    ["create", "patch", "update", "revise"].includes(String(call.action)),
  );
  if (progress.mutationCount === 0) {
    expect(mutations).toHaveLength(0);
    for (const call of workshopCalls) {
      expect(call.action).toSatisfy(
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
  expect(mutations[0]!.receiptText).toContain(proposalId);
  expect(outcome).toMatchObject({ outcome: "proposed", proposalId });
  return "proposed";
}
