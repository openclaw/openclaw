import { AsyncResource } from "node:async_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SKILL_RESOURCE_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/skill-resources.js";
import { createFixtureSkillEntry } from "../../skills/test-support/test-helpers.js";
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
  const tunnel = createWorkerTurnTunnel({
    reconcileWorkspace: reconcileUnchangedLocalWorkspace,
    launchTurn: async ({ turnClaim }) => {
      const identity = createWorkerConnectionIdentity(turnClaim, {
        protocolFeatures: ["worker-gateway-tools-v1"],
        credentialExpiresAtMs: Number.MAX_SAFE_INTEGER,
      });
      const gateway = getWorkerTurnToolSurface(identity)!;
      const surface = await gateway.getSurface(identity);
      await rpc.runInAsyncScope(async () => {
        const invoke = (name: string, args: Record<string, unknown>) =>
          gateway.invoke(
            identity,
            {
              generation: surface.generation,
              toolId: surface.tools.find((tool) => tool.definition.name === name)!.id,
              toolCallId: name,
              arguments: args,
            },
            { send() {} },
          );
        expect(
          await invoke("skills_search", { query: "write plain text file", limit: 1 }),
        ).toMatchObject({
          details: { skills: [{ name: "plain-text", location: skillPath }], hasMore: false },
        });
        expect(await invoke("skills_read", { name: "plain-text" })).toMatchObject({
          details: { content: body },
        });
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
        environment.bootstrapReceipt = {
          ...environment.bootstrapReceipt!,
          protocolFeatures: [
            ...environment.bootstrapReceipt!.protocolFeatures,
            SKILL_RESOURCE_PROTOCOL_FEATURE,
          ],
        };
        return environment;
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
  } finally {
    rpc.emitDestroy();
    input.preparedRunAdmission.close();
  }
});
