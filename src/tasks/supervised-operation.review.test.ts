import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runSupervisedReview } from "./supervised-operation.review.js";
import { parseSupervisedOperationOutcome } from "./supervised-operation.types.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";

const infer = vi.hoisted(() => vi.fn());
vi.mock("../agents/isolated-completion.js", () => ({ runIsolatedCompletion: infer }));
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
const dirs = createTempDirTracker();
afterEach(() => {
  infer.mockReset();
  dirs.cleanup();
});

it.each(["valid", "invalid_json", "invalid_shape", "oversized_receipt"] as const)(
  "returns a bounded explicit review outcome for %s",
  async (kind) => {
    const workspace = dirs.make("review-verdict-");
    await fs.writeFile(`${workspace}/program.ts`, "export const answer = 42;\n");
    const goal = {
      objective: "Review the answer",
      success: [{ id: "checked", description: "Review passed" }],
      partial: [],
    };
    const contract = encodeSupervisedWorkflowContract(
      {
        version: 1,
        workspace,
        profiles: [
          {
            kind: "review",
            id: "review",
            agentId: "poc",
            runtime: "claude-cli",
            model: "anthropic/test",
            instructions: "Check answer",
            paths: ["program.ts"],
            timeoutMs: 1000,
          },
        ],
        acceptance: [{ kind: "receipts", criterionId: "checked", profiles: ["review"] }],
      },
      goal,
    ).contract;
    const profile = contract.profiles[0]!;
    if (profile.kind !== "review") {
      throw new Error("Invalid review fixture");
    }
    const verdict = { accepted: true, summary: "Checked", findings: [] };
    const text =
      kind === "invalid_json"
        ? `Prose\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``
        : kind === "invalid_shape"
          ? JSON.stringify({ ...verdict, accepted: "yes" })
          : kind === "oversized_receipt"
            ? JSON.stringify({
                ...verdict,
                accepted: false,
                findings: Array.from({ length: 5 }, () => ({
                  priority: "P2",
                  detail: '"\\'.repeat(500),
                })),
              })
            : JSON.stringify(verdict);
    expect(Buffer.byteLength(text)).toBeLessThan(32768);
    infer.mockResolvedValue({
      text,
      owner: { kind: "cli", id: "claude-cli" },
      provider: "anthropic",
      model: "test",
    });
    const outcome = await runSupervisedReview({
      contract,
      profile,
      task: { prompt: "Review", goal },
      runtimeWorkspaceDir: dirs.make("review-private-"),
      signal: new AbortController().signal,
      assertCurrent: () => {},
      reserveDispatch: vi.fn(),
    });
    expect(infer).toHaveBeenCalledWith(
      expect.objectContaining({
        outputJsonSchema: expect.objectContaining({
          type: "object",
          $schema: "http://json-schema.org/draft-07/schema#",
          required: ["accepted", "summary", "findings"],
        }),
      }),
    );
    expect(parseSupervisedOperationOutcome(outcome)).toEqual(outcome);
    expect(outcome.status).toBe(kind === "valid" ? "succeeded" : "failed");
    expect(outcome.facts.sourceHash).toBe(outcome.facts.resultHash);
    if (kind !== "valid") {
      expect(outcome.facts.verdictError).toBe(kind);
      expect(outcome.facts).not.toHaveProperty("verdict");
    }
  },
);
