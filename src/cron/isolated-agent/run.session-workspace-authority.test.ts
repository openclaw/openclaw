import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import { hasLiveWorktreeRunLease } from "../../agents/worktrees/run-lease.test-support.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "../../agents/worktrees/service.test-support.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import { cronHandlers } from "../../gateway/server-methods/cron.js";
import {
  CREATOR,
  SESSION,
  SESSION_ID,
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
import {
  createAuthorityCronService,
  prepareAuthorityConfig,
  resetAuthorityRunHarness,
  withAuthorityTools,
} from "./run.authority.test-support.js";
import { realCronSession } from "./run.session.test-support.js";
import { loadRunCronIsolatedAgentTurn, runEmbeddedAgentMock } from "./run.test-harness.js";

const sessionRunner = vi.hoisted(() => ({
  runEmbedded: vi.fn<typeof import("../../agents/embedded-agent-runner/run.js").runEmbeddedAgent>(),
}));
// mock-isolation: Only model execution is synthetic; session admission and filesystem tools stay real.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: sessionRunner.runEmbedded,
}));

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const realSession = await realCronSession();
await Promise.all([
  import("../../auto-reply/dispatch.js"),
  import("../../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);
installRequesterCronAuthorityTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const createRepo = useManagedWorktreeTestRepository();

beforeEach(() => {
  resetAuthorityRunHarness();
  realSession.install();
  sessionRunner.runEmbedded
    .mockReset()
    .mockImplementation((params) => runEmbeddedAgentMock(params));
});

it.each([
  "own",
  "foreign",
  "operator",
  "archived",
  "managed",
  "managed-alias",
  "managed-escape",
  "managed-foreign-owner",
  "managed-manual-owner",
  "isolated-child",
  "isolated-child-managed",
  "isolated-child-reset",
] as const)("scheduled file access respects %s conversation workspace", async (scenario) => {
  // An isolated job created in a conversation is its child and runs in that conversation's binding.
  const isolatedChild = scenario.startsWith("isolated-child");
  const foreignWorkspace = tempDirs.make("cron-foreign-workspace-");
  const foreignKey = "agent:main:dashboard:another-person";
  const targetKey = scenario === "foreign" || scenario === "operator" ? foreignKey : SESSION;
  const config = await prepareAuthorityConfig({
    tools: { allow: [AUTOMATIONS_TOOL_NAME, "read", "write"], fs: { workspaceOnly: true } },
  });
  const managedRoot = scenario.includes("managed")
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
  const ownWorkspace =
    worktree?.path ??
    (scenario === "isolated-child" || scenario === "isolated-child-reset"
      ? tempDirs.make("cron-parent-workspace-")
      : stateDir);
  await fs.writeFile(path.join(stateDir, "sentinel.txt"), "DEFAULT_WORKSPACE");
  await fs.writeFile(path.join(ownWorkspace, "sentinel.txt"), "OWN_WORKSPACE");
  await fs.writeFile(path.join(foreignWorkspace, "sentinel.txt"), "FOREIGN_WORKSPACE");
  let boundWorkspace = ownWorkspace;
  if (worktree && (scenario === "managed-alias" || scenario === "managed-escape")) {
    boundWorkspace =
      scenario === "managed-alias"
        ? path.join(expectDefined(managedRoot, "managed root"), "workspace-alias")
        : path.join(worktree.path, "escaped-workspace");
    await fs.symlink(
      scenario === "managed-alias" ? worktree.path : foreignWorkspace,
      boundWorkspace,
    );
  }
  const creatorEntry = {
    sessionId: SESSION_ID,
    updatedAt: Date.now(),
    sessionStartedAt: Date.now(),
    lastInteractionAt: Date.now(),
    lifecycleRevision: "original",
    createdActor: CREATOR,
    spawnedCwd: boundWorkspace,
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
    sessionTarget: isolatedChild ? "isolated" : `session:${targetKey}`,
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
  if (isolatedChild) {
    expect(job.sourceConversation?.sessionKey).toBe(SESSION);
  }
  if (scenario === "archived") {
    replaceSessionEntrySync({ sessionKey: SESSION }, { ...creatorEntry, archivedAt: Date.now() });
  }
  const reads: string[] = [];
  const refusals: string[] = [];
  runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) =>
    withAuthorityTools(
      params,
      async (tools, admitted) => {
        params.onExecutionPhase?.({ phase: "model_call_started" });
        await params.onExecutionStarted?.();
        await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
        const read = expectDefined(
          tools.find((tool) => tool.name === "read"),
          "read tool",
        );
        if (worktree) {
          expect(hasLiveWorktreeRunLease(process.env, worktree.id)).toBe(true);
        }
        if (scenario === "isolated-child-reset") {
          // Embedded tool authority captures this check at run start and runs it before every tool effect.
          const assertRunActive = expectDefined(
            resolveAdmittedRunActiveAssertion(admitted),
            "admitted run assertion",
          );
          // The parent conversation is reset (`/new`) while its child is running.
          await resetSessionEntryLifecycle({
            storePath: resolveSessionStorePathCore(config.session?.store, { agentId: "main" }),
            target: { canonicalKey: SESSION, storeKeys: [SESSION] },
            buildNextEntry: () => ({
              ...creatorEntry,
              sessionId: "replacement-conversation",
              lifecycleRevision: "reset",
            }),
          });
          try {
            assertRunActive();
            reads.push(
              JSON.stringify(await read.execute("scheduled-read", { path: "sentinel.txt" })),
            );
          } catch (error) {
            refusals.push(String(error));
          }
          return { payloads: [{ text: "Read refused" }], meta: { agentMeta: {} } };
        }
        const result = await read.execute("scheduled-read", { path: "sentinel.txt" });
        reads.push(JSON.stringify(result));
        if (worktree) {
          await expect(
            read.execute("outside", { path: path.join(foreignWorkspace, "sentinel.txt") }),
          ).rejects.toThrow(/outside|escapes sandbox root/i);
        }
        return { payloads: [{ text: "Read complete" }], meta: { agentMeta: {} } };
      },
      isolatedChild ? {} : { sessionKey: targetKey },
    ),
  );
  const execution = createAuthorityCronService(config, runCronIsolatedAgentTurn);
  await execution.start();
  try {
    await execution.run(job.id, "force");
    const result = execution.getJob(job.id)?.state;
    if (scenario === "isolated-child-reset") {
      // The child keeps no access to the reset parent's workspace.
      expect(reads).toEqual([]);
      expect(refusals).toEqual([expect.stringMatching(/no longer active/)]);
    } else if (scenario === "archived") {
      // The occurrence admission pauses the job before any session turn runs.
      expect(reads).toEqual([]);
      expect(result?.lastRunStatus).toBe("skipped");
      expect(result?.lastError).toMatch(/it was archived/);
      expect(execution.getJob(job.id)?.enabled).toBe(false);
    } else if (
      scenario === "foreign" ||
      scenario === "managed-foreign-owner" ||
      scenario === "managed-manual-owner" ||
      scenario === "managed-escape"
    ) {
      expect(reads).toEqual([]);
      expect(result?.lastRunStatus).toBe("error");
      expect(result?.lastError).toMatch(
        scenario === "foreign"
          ? /only use its owning conversation’s workspace/
          : scenario === "managed-escape"
            ? /workspace does not match its managed worktree/
            : /worktree is missing, retired, or mismatched/,
      );
    } else {
      expect(result?.lastRunStatus, result?.lastError).toBe("ok");
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
