import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createOpenClawCodingTools } from "../../agents/agent-tools.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { hasLiveWorktreeRunLease } from "../../agents/worktrees/run-lease.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "../../agents/worktrees/service.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { cronHandlers } from "../../gateway/server-methods/cron.js";
import {
  CREATOR,
  SESSION,
  SESSION_ID,
  cfg,
  stateDir,
  inRun,
  createCronFixture,
  createCreatorTransportTools,
  installRequesterCronAuthorityTestHooks,
} from "../../gateway/server-methods/requester-cron-authority.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { CronService } from "../service.js";
import { createNoopLogger } from "../service.test-harness.js";
import { resolveCronSessionTargetSessionKey } from "../session-target.js";
import {
  ensureAgentWorkspaceMock,
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const session = await vi.importActual<typeof import("./session.js")>("./session.js");
const accessor = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
  "../../config/sessions/session-accessor.js",
);
installRequesterCronAuthorityTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const createRepo = useManagedWorktreeTestRepository();

beforeEach(() => {
  resetRunCronIsolatedAgentTurnHarness();
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  resolveCronSessionMock.mockImplementation(session.prepareCronSession);
  loadSessionEntryMock.mockImplementation(session.loadCronSessionEntryLatest);
  patchSessionEntryMock.mockImplementation(accessor.patchSessionEntryCore);
  ensureAgentWorkspaceMock.mockImplementation(async ({ dir }: { dir: string }) => ({ dir }));
  resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });
  mockRunCronFallbackPassthrough();
});

describe("scheduled workspace authority through creator, storage, scheduler and file tools", () => {
  it.each([
    "own",
    "foreign",
    "operator",
    "archived",
    "managed",
    "managed-foreign-owner",
    "managed-manual-owner",
  ] as const)("%s conversation workspace", async (scenario) => {
    const foreignWorkspace = tempDirs.make("cron-foreign-workspace-");
    const foreignKey = "agent:main:dashboard:another-person";
    const targetKey = scenario === "foreign" || scenario === "operator" ? foreignKey : SESSION;
    const config: OpenClawConfig = {
      ...cfg,
      agents: {
        defaults: { skipBootstrap: true, workspace: stateDir },
        entries: { main: { workspace: stateDir } },
      },
      tools: { allow: [AUTOMATIONS_TOOL_NAME, "read", "write"], fs: { workspaceOnly: true } },
    };
    setRuntimeConfigSnapshot(config);
    const managedRoot = scenario.startsWith("managed")
      ? tempDirs.make("cron-managed-workspace-")
      : undefined;
    const worktree = managedRoot
      ? await materializeManagedWorktreeFixture({
          env: process.env,
          repoRoot: await createRepo(managedRoot),
          stateDir: managedRoot,
          name: "scheduled-workspace",
          ownerKind: scenario === "managed-manual-owner" ? "manual" : "session",
          ownerId: scenario === "managed-foreign-owner" ? foreignKey : SESSION,
          now: Date.now(),
        })
      : undefined;
    const ownWorkspace = worktree?.path ?? stateDir;
    await fs.writeFile(path.join(stateDir, "sentinel.txt"), "DEFAULT_WORKSPACE");
    await fs.writeFile(path.join(ownWorkspace, "sentinel.txt"), "OWN_WORKSPACE");
    await fs.writeFile(path.join(foreignWorkspace, "sentinel.txt"), "FOREIGN_WORKSPACE");
    const creatorEntry = {
      sessionId: SESSION_ID,
      updatedAt: Date.now(),
      sessionStartedAt: Date.now(),
      lastInteractionAt: Date.now(),
      lifecycleRevision: "original",
      createdActor: CREATOR,
      spawnedCwd: ownWorkspace,
      worktree: worktree
        ? { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot }
        : undefined,
    };
    replaceSessionEntrySync({ sessionKey: SESSION }, creatorEntry);
    replaceSessionEntrySync(
      { sessionKey: foreignKey },
      {
        sessionId: "foreign-conversation",
        updatedAt: Date.now(),
        sessionStartedAt: Date.now(),
        lastInteractionAt: Date.now(),
        lifecycleRevision: "foreign",
        spawnedCwd: foreignWorkspace,
        createdActor: { type: "human", source: "profile", id: "another-person" },
      },
    );
    const fixture = createCronFixture(undefined, config);
    const definition = {
      name: `Workspace authority ${scenario}`,
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
        context: fixture.context,
        client: createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] }),
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    } else {
      await inRun("workspace-creator", undefined, async (_identity, admitted) => {
        bindGatewayContextResolver(admitted, () => fixture.context);
        try {
          const tools = await createCreatorTransportTools({
            transport: "embedded",
            config,
            admitted,
            senderIsOwner: true,
          });
          // The same creator cannot read the other directory directly. Scheduling must not widen it.
          await expect(
            tools.invoke("read", { path: path.join(foreignWorkspace, "sentinel.txt") }),
          ).rejects.toThrow(/outside|sandbox root|escapes/i);
          await tools.invoke(AUTOMATIONS_TOOL_NAME, { action: "add", job: definition });
        } finally {
          clearGatewayContextResolver(admitted);
        }
      });
    }
    const job = expectDefined((await fixture.read())[0], "persisted job");
    expect(job.scheduledToolPolicy?.mode).toBe(scenario === "operator" ? "trusted" : "account");
    if (scenario !== "operator") {
      expect(job.owner?.sessionKey).toBe(SESSION);
    }
    if (scenario === "archived") {
      replaceSessionEntrySync({ sessionKey: SESSION }, { ...creatorEntry, archivedAt: Date.now() });
    }
    const reads: string[] = [];
    // The runner is controlled; creator grants, durable rows, admission, tool policy and file I/O are real.
    runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      const admitted = await expectDefined(params.preparedRunAdmission, "run admission").admit(
        "gateway",
        params.runId,
      );
      const caller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admitted,
        agentId: "main",
        sessionKey: targetKey,
      });
      return withGatewayToolCallerIdentity(caller, async () => {
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
        if (worktree) {
          expect(hasLiveWorktreeRunLease(process.env, worktree.id)).toBe(true);
        }
        const result = await read.execute("scheduled-read", { path: "sentinel.txt" });
        reads.push(JSON.stringify(result));
        return { payloads: [{ text: "Read complete" }], meta: { agentMeta: {} } };
      });
    });
    const execution = new CronService({
      scheduler: createTestGatewayScheduler(),
      storePath: path.join(stateDir, "cron", "jobs.json"),
      cronEnabled: true,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: (request) =>
        runCronIsolatedAgentTurn({
          ...request,
          cfg: config,
          deps: {},
          agentId: "main",
          sessionKey:
            resolveCronSessionTargetSessionKey(request.job.sessionTarget) ??
            `cron:${request.job.id}`,
        }),
    });
    await execution.start();
    try {
      await execution.run(job.id, "force");
      if (scenario === "foreign" || scenario === "archived" || scenario.startsWith("managed-")) {
        expect(reads).toEqual([]);
        expect(execution.getJob(job.id)?.state.lastRunStatus).toBe("error");
      } else {
        expect(execution.getJob(job.id)?.state.lastRunStatus).toBe("ok");
        expect(reads).toHaveLength(1);
        expect(reads[0]).toContain(scenario === "operator" ? "FOREIGN_WORKSPACE" : "OWN_WORKSPACE");
      }
      if (worktree) {
        expect(hasLiveWorktreeRunLease(process.env, worktree.id)).toBe(false);
      }
    } finally {
      execution.stop();
    }
  });
});
