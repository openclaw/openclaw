import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { cronHandlers } from "../gateway/server-methods/cron.js";
import {
  CREATOR,
  SESSION,
  SESSION_ID,
  stateDir,
  createCronFixture,
  createCreatorTransportTools,
  inRun,
  installRequesterCronAuthorityTestHooks,
} from "../gateway/server-methods/requester-cron-authority.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import { runCronSessionTurn } from "./session-run.js";

// mock-isolation: Keep real admission and filesystem authority while replacing model inference at the runner boundary.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: vi.fn(),
}));

installRequesterCronAuthorityTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
// Exercise authority with the real reply runtime already transformed, as ordinary reply suites do.
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply.js"),
]);
beforeEach(() => {
  runEmbeddedAgentMock.mockReset();
  vi.stubEnv("OPENCLAW_TEST_FAST", "0");
});

it.each(["own", "foreign", "operator"] as const)(
  "preserves scheduled %s workspace authority through ordinary reply execution",
  async (scenario) => {
    const foreignWorkspace = tempDirs.make("session-automation-foreign-");
    const foreignKey = "agent:main:dashboard:another-person";
    const targetKey = scenario === "own" ? SESSION : foreignKey;
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          skipBootstrap: true,
          workspace: stateDir,
          model: { primary: "mock-openai/gpt-5.6-luna" },
          models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
        },
        entries: { main: { workspace: stateDir } },
      },
      plugins: { enabled: false },
      skills: { load: { watch: false } },
      tools: { allow: [AUTOMATIONS_TOOL_NAME, "read", "write"], fs: { workspaceOnly: true } },
    };
    setRuntimeConfigSnapshot(config);
    await fs.writeFile(path.join(stateDir, "sentinel.txt"), "OWN_WORKSPACE");
    await fs.writeFile(path.join(foreignWorkspace, "sentinel.txt"), "FOREIGN_WORKSPACE");
    for (const [sessionKey, sessionId, workspace, creator] of [
      [SESSION, SESSION_ID, stateDir, CREATOR],
      [
        foreignKey,
        "foreign-conversation",
        foreignWorkspace,
        { type: "human", source: "profile", id: "another-person" } as const,
      ],
    ] as const) {
      replaceSessionEntrySync(
        { sessionKey },
        {
          sessionId,
          updatedAt: Date.now(),
          lifecycleRevision: sessionId,
          spawnedCwd: workspace,
          createdActor: creator,
        },
      );
    }
    const creator = createCronFixture(undefined, config);
    const definition = {
      name: `Session workspace ${scenario}`,
      enabled: false,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: `session:${targetKey}`,
      payload: { kind: "agentTurn", message: "Read sentinel.txt", toolsAllow: ["read"] },
      delivery: { mode: "none" },
    };
    if (scenario === "operator") {
      const respond = vi.fn();
      await expectDefined(
        cronHandlers["cron.add"],
        "cron.add",
      )({
        req: { type: "req", id: "operator-create", method: "cron.add", params: definition },
        params: definition,
        respond,
        context: creator.context,
        client: createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] }),
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    } else {
      await inRun("session-workspace-creator", undefined, async (_identity, admitted) => {
        bindGatewayContextResolver(admitted, () => creator.context);
        try {
          const tools = await createCreatorTransportTools({
            transport: "embedded",
            config,
            admitted,
            senderIsOwner: true,
          });
          await expect(
            tools.invoke("read", { path: path.join(foreignWorkspace, "sentinel.txt") }),
          ).rejects.toThrow(/outside|sandbox root|escapes/i);
          await tools.invoke(AUTOMATIONS_TOOL_NAME, { action: "add", job: definition });
        } finally {
          clearGatewayContextResolver(admitted);
        }
      });
    }
    const job = expectDefined((await creator.read())[0], "persisted job");
    const reads: string[] = [];
    runEmbeddedAgentMock.mockImplementation(async (params) => {
      const admitted = await expectDefined(
        params.preparedRunAdmission,
        "scheduled admission",
      ).admit("gateway", params.runId);
      await params.onExecutionStarted?.();
      params.onExecutionPhase?.({ phase: "model_call_started" });
      if (scenario !== "foreign") {
        expect(admitted.admissionSource).toBe(
          scenario === "operator" ? "operator-schedule" : "requester-schedule",
        );
      }
      return withGatewayToolCallerIdentity(
        createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: "main",
          sessionKey: targetKey,
        }),
        async () => {
          const tools = createOpenClawCodingTools({
            config: params.config,
            agentId: "main",
            sessionKey: targetKey,
            sessionId: params.sessionId,
            runId: params.runId,
            operationalRunInstance: admitted.operationalRunInstance,
            workspaceDir: params.workspaceDir,
            cwd: params.cwd,
            runtimeToolAllowlist: params.toolsAllow,
            scheduledToolPolicy: params.scheduledToolPolicy,
            toolConstructionPlan: {
              includeBaseCodingTools: true,
              includeShellTools: false,
              includeChannelTools: false,
              includeOpenClawTools: false,
              includePluginTools: false,
            },
          });
          const read = expectDefined(
            tools.find((tool) => tool.name === "read"),
            "read tool",
          );
          reads.push(
            JSON.stringify(await read.execute("scheduled-read", { path: "sentinel.txt" })),
          );
          return { payloads: [{ text: "Read complete" }], meta: { durationMs: 1 } };
        },
      );
    });
    const execution = new CronService({
      scheduler: createTestGatewayScheduler(),
      storePath: path.join(stateDir, "cron", "jobs.json"),
      cronEnabled: true,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        throw new Error("Expected ordinary session execution");
      }),
      runSessionEvent: (request) =>
        runCronSessionTurn({ ...request, cfg: config, agentId: "main", sessionKey: targetKey }),
    });
    await execution.start();
    try {
      await execution.run(job.id, "force");
      const outcome = execution.getJob(job.id)?.state;
      if (scenario === "foreign") {
        expect(reads).toEqual([]);
        expect(outcome).toMatchObject({
          lastRunStatus: "error",
          lastError: expect.stringContaining("owning conversation"),
        });
      } else {
        expect(outcome?.lastRunStatus, outcome?.lastError).toBe("ok");
        expect(reads).toHaveLength(1);
        expect(reads[0]).toContain(scenario === "operator" ? "FOREIGN_WORKSPACE" : "OWN_WORKSPACE");
      }
    } finally {
      execution.stop();
    }
  },
);
