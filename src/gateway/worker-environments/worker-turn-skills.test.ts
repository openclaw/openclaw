import { AsyncResource } from "node:async_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SKILL_RESOURCE_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/skill-resources.js";
import { runUntilCompleted, resetCodeModeTestState } from "../../agents/code-mode.test-support.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../../agents/harness/tool-surface-bridge.js";
import { createFixtureSkillEntry } from "../../skills/test-support/test-helpers.js";
import { createWorkerGatewayToolProxies } from "../../worker/worker-gateway-tools.js";
import { createWorkerConnectionIdentity } from "./connection-identity.test-support.js";
import { getWorkerTurnToolSurface } from "./placement-turn-claim-events.js";
import { WorkerRunnerCapacityError } from "./tunnel-contract.js";
import {
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  createWorkerTurnTunnel,
  credential,
  placements,
  reconcileUnchangedLocalWorkspace,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";

beforeEach(setupWorkerTurnLauncherTest);
afterEach(async () => {
  await resetCodeModeTestState();
  await cleanupWorkerTurnLauncherTest();
  vi.unstubAllEnvs();
});

it("searches and reads installed skills from a worker RPC outside the launching turn context", async () => {
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
  await seedActivePlacement();
  const rpc = new AsyncResource("worker-skill-rpc");
  const input = turn("worker-skills");
  const body = "# Plain text\nWrite plain text files with the write tool.\n";
  const skillPath = path.join(root, "plain-text", "SKILL.md");
  await mkdir(path.dirname(skillPath));
  await writeFile(skillPath, body);
  let result: Awaited<ReturnType<typeof runUntilCompleted>> | undefined;
  const tunnel = createWorkerTurnTunnel({
    reconcileWorkspace: reconcileUnchangedLocalWorkspace,
    launchTurn: async ({ plan, turnClaim }) => {
      const identity = createWorkerConnectionIdentity(turnClaim, {
        environmentId: plan.admission.environmentId,
        ownerEpoch: plan.admission.ownerEpoch,
        sessionId: input.sessionId,
        runId: input.runId,
        credentialHash: "fixture-credential-hash",
        protocolFeatures: ["worker-gateway-tools-v1"],
        credentialExpiresAtMs: Number.MAX_SAFE_INTEGER,
      });
      const gateway = getWorkerTurnToolSurface(identity)!;
      const surface = await gateway.getSurface(identity);
      result = await rpc.runInAsyncScope(async () => {
        const runtime = createAgentHarnessToolSurfaceRuntimeCore({
          agentId: input.agentId,
          sessionId: input.sessionId,
          sessionKey: input.sessionKey,
          runId: input.runId,
          presentation: surface.presentation,
          modelToolsEnabled: true,
        });
        try {
          const tools = createWorkerGatewayToolProxies(surface, {
            invokeGatewayTool: async (request) => ({
              type: "res",
              id: "fixture-reply",
              ok: true,
              payload: await gateway.invoke(identity, request, { send() {} }),
            }),
            cancelGatewayTool: async (request) => ({
              type: "res",
              id: "fixture-cancel",
              ok: true,
              payload: gateway.cancel(request),
            }),
          });
          const projected = runtime
            .compactTools(tools, { prepared: { preserveToolNames: [] } })
            .promptToolPolicy.apply();
          return await runUntilCompleted({
            execTool: projected.tools.find((tool) => tool.name === "exec")!,
            waitTool: projected.tools.find((tool) => tool.name === "wait")!,
            code: 'return { found: await skills.search("write plain text file", 1), body: await skills.read("plain-text") };',
          });
        } finally {
          runtime.cleanup();
        }
      });
      throw new WorkerRunnerCapacityError();
    },
  });
  const provider = createWorkerSessionTurnPlacementProvider({
    placements,
    environments: {
      ...unusedEnvironments(),
      get: () => {
        const environment = attachedEnvironment();
        return {
          ...environment,
          bootstrapReceipt: {
            ...environment.bootstrapReceipt!,
            protocolFeatures: [
              ...environment.bootstrapReceipt!.protocolFeatures,
              SKILL_RESOURCE_PROTOCOL_FEATURE,
            ],
          },
        };
      },
      acquireTurnCredential: async () => credential(),
      startTunnel: async () => tunnel,
    },
  });
  try {
    await expect(
      provider.executeTurn(
        { ...sessionTarget, runId: input.runId },
        {
          ...input,
          config: { ...input.config, tools: { codeMode: true } },
          toolsAllow: ["skills_search", "skills_read"],
          skillsSnapshot: {
            prompt: "",
            skills: [{ name: "plain-text" }],
            discoverySkills: [
              {
                ...createFixtureSkillEntry("plain-text").skill,
                description: "Write plain text files",
                filePath: skillPath,
                baseDir: path.dirname(skillPath),
                readContent: body,
              },
            ],
          },
        },
        vi.fn(),
      ),
    ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
    expect(result, String(result?.error)).toMatchObject({
      status: "completed",
      value: {
        found: { skills: [{ name: "plain-text", location: skillPath }], hasMore: false },
        body: expect.stringContaining(body),
      },
    });
  } finally {
    rpc.emitDestroy();
    input.preparedRunAdmission.close();
  }
});
