// A worker turn runs the approved model, so that model's size metadata selects the Agent Profile
// that bounds the workspace context of the prompt the worker receives.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkerRunnerCapacityError } from "./tunnel-contract.js";
import * as worker from "./worker-turn-launcher.test-support.js";

beforeEach(worker.setupWorkerTurnLauncherTest);
afterEach(() => worker.cleanupWorkerTurnLauncherTest());

async function workerSystemPrompt(modelSizeClass: "small" | undefined) {
  await worker.seedActivePlacement();
  const input = worker.turn(`worker-profile-${modelSizeClass ?? "unbound"}`);
  await writeFile(path.join(worker.root, "AGENTS.md"), "a".repeat(12_000));
  const openai = input.config.models.providers.openai;
  const config = {
    ...input.config,
    models: {
      providers: {
        openai: {
          ...openai,
          models: [
            {
              id: input.model,
              name: input.model,
              reasoning: false,
              input: ["text" as const],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_768,
              maxTokens: 4_096,
              ...(modelSizeClass ? { modelSizeClass } : {}),
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        ...input.config.agents.defaults,
        workspace: worker.root,
        agentProfileId: "auto" as const,
      },
    },
  };
  let systemPrompt = "";
  const tunnel = worker.createWorkerTurnTunnel({
    reconcileWorkspace: worker.reconcileUnchangedLocalWorkspace,
    launchTurn: async (request) => {
      systemPrompt = request.plan.assignment.systemPrompt ?? "";
      throw new WorkerRunnerCapacityError();
    },
  });
  const provider = worker.createWorkerSessionTurnPlacementProvider({
    placements: worker.placements,
    environments: {
      ...worker.unusedEnvironments(),
      get: worker.attachedEnvironment,
      acquireTurnCredential: async () => worker.credential(),
      startTunnel: async () => tunnel,
    },
  });
  try {
    await expect(
      provider.executeTurn(
        { ...worker.sessionTarget, runId: input.runId },
        { ...input, config },
        vi.fn(),
      ),
    ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
  } finally {
    input.preparedRunAdmission.close();
  }
  return systemPrompt;
}

it("bounds the worker prompt workspace context for a small approved model", async () => {
  const systemPrompt = await workerSystemPrompt("small");
  expect(systemPrompt).toContain("a".repeat(1_000));
  expect(systemPrompt).not.toContain("a".repeat(7_501));
  expect(systemPrompt).toContain("[...truncated, read AGENTS.md for full content...]");
});

it("keeps the full worker prompt workspace context for an approved model without size metadata", async () => {
  const systemPrompt = await workerSystemPrompt(undefined);
  expect(systemPrompt).toContain("a".repeat(12_000));
});
