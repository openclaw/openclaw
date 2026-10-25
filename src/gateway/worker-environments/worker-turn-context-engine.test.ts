import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { createContextEngineLogicalTurnLease } from "../../agents/harness/context-engine-logical-turn.js";
import { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { registerContextEngineInRegistry } from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import * as worker from "./worker-turn-launcher.test-support.js";

beforeEach(worker.setupWorkerTurnLauncherTest);
afterEach(worker.cleanupWorkerTurnLauncherTest);
afterEach(resetGlobalHookRunner);

it.each(["direct", "outer"] as const)("prepares and settles with %s ownership", async (owner) => {
  const events: string[] = [];
  const record = (event: string) => async () => void events.push(event);
  await worker.seedActivePlacement();
  const input = worker.turn(`context-engine-${owner}`);
  const acceptedFile = path.join(input.workspaceDir, "accepted-project.txt");
  const followUpFile = path.join(input.workspaceDir, "engine-follow-up.txt");
  await writeFile(acceptedFile, "previous Gateway content");
  const engineId = `worker-context-${owner}`;
  const config = { ...input.config, plugins: { slots: { contextEngine: engineId } } };
  const previous = await worker.openSessionManager();
  await previous.appendMessageAsync(
    makeAgentUserMessage({ content: "Unassembled history", timestamp: 1 }),
  );
  const history = "Selected engine history";
  const assembledHistory = makeAgentUserMessage({ content: history, timestamp: 2 });
  const answer = makeAgentAssistantMessage({
    content: [{ type: "text", text: "Fresh worker answer" }],
    timestamp: 3,
  });
  const recorder = createUserTurnTranscriptRecorder({
    target: { ...worker.sessionTarget, sessionEntry: undefined },
    input: { text: input.prompt },
  });
  let claim: WorkerSessionTurnClaim | undefined;
  const fences: Array<ReturnType<typeof resolveSessionTranscriptReadFence>> = [];
  const bootstrap = vi.fn<NonNullable<ContextEngine["bootstrap"]>>(async () => {
    events.push("bootstrap");
    fences.push(resolveSessionTranscriptReadFence(worker.sessionTarget));
    return { bootstrapped: true };
  });
  const assemble = vi.fn<ContextEngine["assemble"]>(async () => {
    events.push("assemble");
    fences.push(resolveSessionTranscriptReadFence(worker.sessionTarget));
    return {
      messages: [assembledHistory],
      estimatedTokens: 10,
      systemPromptAddition: "Selected engine memory enrichment.",
    };
  });
  const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async (params) => {
    events.push("after-turn");
    const cwd = params.runtimeContext?.cwd;
    assert(cwd);
    assert(claim);
    const content = await readFile(path.join(cwd, "accepted-project.txt"), "utf8");
    expect(cwd).toBe(input.workspaceDir);
    expect(content).toBe("accepted node content");
    expect(worker.placements.validateWorkspaceResultClaim(claim)).toBe(true);
    await writeFile(path.join(cwd, "engine-follow-up.txt"), content);
  });
  const dispose = vi.fn(record("dispose"));
  const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => ({
    status: "committed",
  }));
  const compact = vi.fn<ContextEngine["compact"]>(async () => ({ ok: true, compacted: false }));
  const engine: ContextEngine = {
    info: {
      id: engineId,
      name: "Worker context fixture",
      hostRequirements: {
        "agent-run": {
          requiredCapabilities: ["bootstrap", "assemble-before-prompt", "after-turn"],
        },
      },
      transcriptSemantics: {
        currentTurnFence: "before-current-turn-entry-v1",
        turnAdvancementIdempotency: "atomic-idempotent-v1",
      },
    },
    ingest: async () => ({ ingested: true }),
    bootstrap,
    assemble,
    afterTurn,
    commitTurn,
    compact,
    dispose,
  };
  await using runtime = await acquireAgentRunPreparedModelRuntime({
    config,
    agentId: input.agentId,
    agentDir: resolveAgentDir(config, input.agentId),
    workspaceDir: input.workspaceDir,
  });
  const registry = runtime.snapshot.pluginRegistry;
  assert(registry);
  expect(registerContextEngineInRegistry(registry, engineId, () => engine, "core")).toEqual({
    ok: true,
  });
  const lease =
    owner === "outer"
      ? await withPluginRuntimeGenerationScope(runtime.snapshot, () =>
          createContextEngineLogicalTurnLease({
            identity: input,
            config,
            workspaceDir: input.workspaceDir,
          }),
        )
      : undefined;
  const candidate = vi.fn(() => {
    events.push("candidate");
  });
  let terminal:
    | Awaited<ReturnType<SessionManager["appendMessageWithTranscriptAnchorAsync"]>>
    | undefined;
  const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async (request) => {
    events.push("launch");
    claim = request.turnClaim;
    request.onDispatchReady?.();
    const completed = await worker.openSessionManager();
    terminal = await completed.appendMessageWithTranscriptAnchorAsync(answer);
    return await worker.acknowledgeCompletedWorkerTurn(request.turnClaim, terminal.entryId);
  });
  const tunnel = worker.createWorkerTurnTunnel({
    launchTurn,
    reconcileWorkspace: vi.fn(async (request) => {
      events.push("reconcile");
      await writeFile(acceptedFile, "accepted node content");
      return { ...(await worker.reconcileUnchangedLocalWorkspace(request)), changed: true };
    }),
  });
  const published = vi.fn(record("publish"));
  const provider = worker.createWorkerSessionTurnPlacementProvider({
    placements: worker.placements,
    publishAcceptedWorkspace: published,
    environments: worker.workerTurnEnvironments(tunnel, {
      acknowledgeCredentialDelivery: async () => true,
    }),
  });
  try {
    const result = await provider.executeTurn(
      { ...worker.sessionTarget, runId: input.runId },
      {
        ...input,
        config,
        pluginGeneration: runtime.pluginGeneration,
        contextTokenBudget: 32_768,
        toolsAllow: ["read"],
        userTurnTranscriptRecorder: recorder,
        ...(lease
          ? { contextEngineLogicalTurnLease: lease, onContextEngineTurnCandidate: candidate }
          : {}),
      },
      vi.fn(),
    );
    expect(result.payloads).toEqual([{ text: "Fresh worker answer" }]);
    assert(claim);
    expect(worker.placements.validateWorkspaceResultClaim(claim)).toBe(true);
    await waitForSessionRunEnd(worker.SESSION_ID, null);
    expect(published).toHaveBeenCalledExactlyOnceWith(claim);
    expect(worker.placements.validateWorkspaceResultClaim(claim)).toBe(false);
    expect(worker.placements.get(worker.SESSION_ID)?.turnClaim).toBeNull();
    const admission = recorder.getAdmissionReceipt();
    expect(admission).toBeDefined();
    expect(fences).toEqual([admission, admission]);
    expect(bootstrap.mock.calls[0]?.[0].runtimeSettings).toMatchObject({
      model: { provider: "openai", resolved: input.model },
      limits: { promptTokenBudget: 32_768 },
    });
    const assembly = assemble.mock.calls[0]?.[0];
    expect(assembly).toMatchObject({
      model: input.model,
      prompt: input.prompt,
      availableTools: new Set(["read"]),
      runtimeContext: { cwd: input.workspaceDir },
    });
    expect(assembly?.tokenBudget).toBeGreaterThan(0);
    expect(assembly?.tokenBudget).toBeLessThan(32_768);
    const assignment = launchTurn.mock.calls[0]?.[0].plan.assignment;
    expect(assignment?.systemPrompt).toContain("Selected engine memory enrichment.");
    expect(JSON.stringify(assignment?.initialMessages)).toContain(history);
    expect(JSON.stringify(assignment?.initialMessages)).not.toContain("Unassembled history");
    expect(commitTurn).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    if (lease) {
      expect(afterTurn).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
      expect(candidate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          boundary: { admission, terminal: terminal?.anchor },
          runtimeContext: expect.objectContaining({
            provider: "openai",
            modelId: input.model,
            tokenBudget: 32_768,
          }),
        }),
      );
      await lease.dispose();
      await expect(readFile(followUpFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(afterTurn.mock.calls[0]?.[0]).toMatchObject({
        prePromptMessageCount: 1,
        tokenBudget: 32_768,
        messages: [
          expect.objectContaining({ role: "user", content: expect.stringContaining(history) }),
          expect.objectContaining({ role: "user", content: input.prompt }),
          expect.objectContaining({ role: "assistant", content: answer.content }),
        ],
      });
      await expect(readFile(followUpFile, "utf8")).resolves.toBe("accepted node content");
    }
    expect(events).toEqual([
      "bootstrap",
      "assemble",
      "launch",
      ...(lease ? ["candidate"] : []),
      "reconcile",
      "publish",
      ...(lease ? [] : ["after-turn"]),
      "dispose",
    ]);
  } finally {
    await lease?.dispose();
    registry.contextEngines.delete(engineId);
    input.preparedRunAdmission.close();
  }
});
