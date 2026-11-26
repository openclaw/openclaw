// A worker turn runs the approved model, so that model's size metadata selects the Agent Profile.
// The profile bounds the workspace context and selects the inbound context serialization of the
// prompt the worker receives.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveNodeWorkerLaunchToolNames } from "../../infra/node-runner-inventory.js";
import { WorkerRunnerCapacityError } from "./tunnel-contract.js";
import * as worker from "./worker-turn-launcher.test-support.js";

beforeEach(worker.setupWorkerTurnLauncherTest);
afterEach(() => worker.cleanupWorkerTurnLauncherTest());

async function workerPrompt(options: {
  agentProfileId: "auto" | "openclaw/base" | "openclaw/small";
  modelSizeClass?: "small";
  currentInboundContext?: { text: string; compactText: string };
}) {
  const { agentProfileId, modelSizeClass, currentInboundContext } = options;
  await worker.seedActivePlacement();
  const input = worker.turn(`worker-profile-${agentProfileId}-${modelSizeClass ?? "unbound"}`);
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
        agentProfileId,
      },
    },
  };
  let systemPrompt = "";
  let runtimeContext: unknown;
  const launchToolNames = resolveNodeWorkerLaunchToolNames({
    enabled: true,
    capacity: { total: 1, available: 1 },
    environmentSession: 1,
    capturedExecPolicy: true,
    promptContext: 1,
  });
  const tunnel = worker.createWorkerTurnTunnel({
    readLaunchToolNames: async () => launchToolNames,
    reconcileWorkspace: worker.reconcileUnchangedLocalWorkspace,
    launchTurn: async (request) => {
      systemPrompt = request.plan.assignment.systemPrompt ?? "";
      runtimeContext = request.plan.assignment.runtimeContext;
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
        { ...input, config, ...(currentInboundContext ? { currentInboundContext } : {}) },
        vi.fn(),
      ),
    ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
  } finally {
    input.preparedRunAdmission.close();
  }
  return { systemPrompt, runtimeContext };
}

it("bounds the worker prompt workspace context for a small approved model", async () => {
  const { systemPrompt } = await workerPrompt({
    agentProfileId: "auto",
    modelSizeClass: "small",
  });
  expect(systemPrompt).toContain("a".repeat(1_000));
  expect(systemPrompt).not.toContain("a".repeat(7_501));
  expect(systemPrompt).toContain("[...truncated, read AGENTS.md for full content...]");
});

it("keeps the full worker prompt workspace context for an approved model without size metadata", async () => {
  const { systemPrompt } = await workerPrompt({ agentProfileId: "auto" });
  expect(systemPrompt).toContain("a".repeat(12_000));
});

it.each([
  {
    agentProfileId: "openclaw/small",
    sent: "Compact sender block",
    omitted: "Verbose sender block",
  },
  {
    agentProfileId: "openclaw/base",
    sent: "Verbose sender block",
    omitted: "Compact sender block",
  },
] as const)(
  "sends the $agentProfileId serialization of the inbound context to the worker",
  async ({ agentProfileId, sent, omitted }) => {
    const { runtimeContext } = await workerPrompt({
      agentProfileId,
      currentInboundContext: { text: "Verbose sender block", compactText: "Compact sender block" },
    });
    expect(runtimeContext).toContainEqual({ kind: "conversation-data", text: sent });
    expect(runtimeContext).not.toContainEqual({ kind: "conversation-data", text: omitted });
  },
);
