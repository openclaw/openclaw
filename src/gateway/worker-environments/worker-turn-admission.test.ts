import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END } from "@openclaw/ai/internal/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_TURN_ADMISSION_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-turn-admission.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeAgentRunEvent } from "../../plugins/hook-types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { prepareSkillBundle } from "../../skills/library/bundle.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { runWorkerEmbeddedTurn } from "../../worker/embedded-agent.runtime.js";
import { getWorkerTurnAdmission, getWorkerTurnToolSurface } from "./placement-turn-claim-events.js";
import {
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  createWorkerTurnTunnel,
  credential,
  openSessionManager,
  placements,
  readWorkerTurnTranscriptStorageRows,
  reconcileUnchangedLocalWorkspace,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";

afterAll(closeStateDatabaseForTest);

describe("worker-side before_agent_run admission", () => {
  beforeEach(async () => {
    await setupWorkerTurnLauncherTest();
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
  });
  afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));
  afterEach(resetGlobalHookRunner);
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { modern: true, block: false, recorderOwned: false },
    { modern: true, block: false, recorderOwned: true },
    { modern: true, block: true, recorderOwned: false },
    { modern: true, block: true, recorderOwned: true },
    { modern: false, block: true, recorderOwned: false },
  ])(
    "gates the final worker prompt before inference and persistence (%j)",
    async ({ modern, block, recorderOwned }) => {
      await seedActivePlacement();
      const input = turn(`admission-${modern}-${block}-${recorderOwned}`);
      const recorder = recorderOwned
        ? createUserTurnTranscriptRecorder({
            target: () => ({ ...sessionTarget, sessionEntry: undefined }),
            input: { text: input.prompt },
          })
        : undefined;
      let messagesAtGate: unknown[] | undefined;
      const handler = vi.fn(async (event: PluginHookBeforeAgentRunEvent) => {
        // Both Gateway persistence owners must wait for the policy decision.
        messagesAtGate = (await openSessionManager()).buildSessionContext().messages;
        return block || !event.systemPrompt?.includes("stable prefix")
          ? { outcome: "block" as const, reason: "Synthetic policy", message: "Request blocked." }
          : { outcome: "pass" as const };
      });
      await using runtime = await acquireAgentRunPreparedModelRuntime({
        config: input.config,
        agentId: input.agentId,
        agentDir: resolveAgentDir(input.config, input.agentId),
        workspaceDir: input.workspaceDir,
      });
      const registry = runtime.snapshot.pluginRegistry;
      assert(registry);
      const registration = {
        pluginId: "admission-policy",
        hookName: "before_agent_run" as const,
        handler,
        source: "test",
      };
      registry.typedHooks.push(registration);
      initializeGlobalHookRunner(registry);
      const environment = attachedEnvironment();
      const bootstrapReceipt = environment.bootstrapReceipt;
      assert(bootstrapReceipt);
      if (modern) {
        bootstrapReceipt.protocolFeatures.push(WORKER_TURN_ADMISSION_PROTOCOL_FEATURE);
      }
      const observedModel = new Error("Synthetic model boundary reached");
      let promptForWorker: string | undefined;
      const stream = vi.fn<Parameters<typeof runWorkerEmbeddedTurn>[0]["inference"]["stream"]>(
        ({ context }) => {
          const event = handler.mock.calls[0]?.[0];
          expect(event?.systemPrompt).toBe(context.systemPrompt);
          expect(context.systemPrompt).toContain("stable prefix\nRuntime: agent=main | host=");
          expect(context.systemPrompt).toContain("skill-resources-");
          expect(context.systemPrompt).not.toContain("/gateway/skills/stable/SKILL.md");
          throw observedModel;
        },
      );
      const launch = vi.fn<NonNullable<ReturnType<typeof createWorkerTurnTunnel>["launchTurn"]>>(
        async ({ plan, turnClaim, onDispatchReady, assertCurrent }) => {
          onDispatchReady?.();
          assert(typeof plan.assignment.prompt === "string");
          promptForWorker = plan.assignment.prompt;
          const identity = {
            environmentId: environment.environmentId,
            ownerEpoch: environment.ownerEpoch,
            sessionId: turnClaim.sessionId,
            runId: turnClaim.runId,
            turnClaim,
            credentialHash: credential().deliveryId,
            bundleHash: bootstrapReceipt.bundleHash,
            rpcSetVersion: 1,
            protocolFeatures: bootstrapReceipt.protocolFeatures,
            credentialExpiresAtMs: Date.now() + 60_000,
          };
          const toolRuntime = getWorkerTurnToolSurface(identity);
          const admit = getWorkerTurnAdmission(identity);
          assert(toolRuntime);
          assert(admit);
          const files = [
            { path: "SKILL.md", content: "# Stable worker skill\n", encoding: "utf8" as const },
          ];
          await runWorkerEmbeddedTurn({
            ...plan.assignment,
            systemPrompt:
              `stable prefix\nRuntime: agent=main${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}\n` +
              "<available_skills>\n<skill>\n<name>stable</name>\n" +
              "<location>/gateway/skills/stable/SKILL.md</location>\n</skill>\n</available_skills>",
            skillResources: {
              version: 1,
              skills: [
                {
                  name: "stable",
                  description: "Worker admission fixture",
                  sourcePath: "/gateway/skills/stable/SKILL.md",
                  revision: prepareSkillBundle(files).revision,
                  files,
                },
              ],
            },
            cwd: root,
            workerContainmentRoot: root,
            stateDir: path.join(root, "worker-state"),
            sessionId: turnClaim.sessionId,
            sessionKey: sessionTarget.sessionKey,
            inference: { stream },
            transcript: { commit: async () => {} },
            live: { enqueuePreview: () => true, emitTerminal: async () => {} },
            gatewayTools: {
              invokeGatewayTool: async () => {
                throw new Error("Unexpected tool call");
              },
              cancelGatewayTool: async () => ({ cancelled: false }),
            },
            toolSurface: await toolRuntime.getSurface(identity),
            allowedToolNames: plan.assignment.toolAuthority.allowedToolNames,
            execAuthority: plan.assignment.toolAuthority.exec,
            admitTurn: async (event) => {
              const result = await admit(
                { ...event, runEpoch: environment.ownerEpoch },
                assertCurrent,
              );
              if (result.outcome === "allow") {
                expect(result.baseLeafId).toBe((await openSessionManager()).getLeafId());
                expect(result.baseLeafId).not.toBeNull();
              }
              return result.outcome === "allow";
            },
          });
          return {
            stdout: "",
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
            termination: "exit",
          };
        },
      );
      const tunnel = createWorkerTurnTunnel({
        launchTurn: launch,
        reconcileWorkspace: reconcileUnchangedLocalWorkspace,
      });
      const environments = {
        ...unusedEnvironments(),
        get: () => environment,
        acquireTurnCredential: async () => credential(),
        startTunnel: async () => tunnel,
        acknowledgeCredentialDelivery: async () => true,
      };
      const provider = createWorkerSessionTurnPlacementProvider({ placements, environments });
      try {
        const execution = provider.executeTurn(
          { ...sessionTarget, runId: input.runId },
          {
            ...input,
            pluginGeneration: runtime.pluginGeneration,
            userTurnTranscriptRecorder: recorder,
          },
          vi.fn(),
        );
        if (block) {
          const result = await execution;
          expect(result.meta.error?.kind).toBe("hook_block");
          expect(result.meta.livenessState).toBe("blocked");
          expect(stream).not.toHaveBeenCalled();
          const messages = (await openSessionManager()).buildSessionContext().messages;
          expect(messages).toEqual([
            expect.objectContaining({
              role: "user",
              content: [{ type: "text", text: result.payloads?.[0]?.text }],
              idempotencyKey: `hook-block:before_agent_run:user:${input.runId}`,
            }),
          ]);
          expect(JSON.stringify(readWorkerTurnTranscriptStorageRows())).not.toContain(input.prompt);
        } else {
          await expect(execution).rejects.toThrow(observedModel.message);
          expect(stream).toHaveBeenCalledOnce();
          expect((await openSessionManager()).buildSessionContext().messages).toEqual([
            expect.objectContaining({
              role: "user",
              content: recorderOwned ? input.prompt : [{ type: "text", text: input.prompt }],
            }),
          ]);
        }
        expect(handler).toHaveBeenCalledOnce();
        expect(messagesAtGate).toEqual([]);
        expect(handler.mock.calls[0]?.[0]).toMatchObject({
          prompt: modern ? promptForWorker : input.prompt,
          messages: [],
          channelId: "telegram",
          accountId: "worker-account",
        });
        if (modern) {
          expect(launch).toHaveBeenCalledOnce();
          expect(handler.mock.calls[0]?.[0].systemPrompt).toContain("stable prefix");
        } else {
          expect(launch).not.toHaveBeenCalled();
          expect(handler.mock.calls[0]?.[0]).not.toHaveProperty("systemPrompt");
        }
      } finally {
        registry.typedHooks.splice(registry.typedHooks.indexOf(registration), 1);
        input.preparedRunAdmission.close();
      }
    },
  );
});
