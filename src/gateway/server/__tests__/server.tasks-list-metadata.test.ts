import { err } from "@openclaw/normalization-core/result";
import { afterAll, expect, test, vi } from "vitest";
import type { TasksListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createInitialSubagentSession } from "../../../agents/subagents/spawn/subagent-spawn-session-patch.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import * as sessionAccessor from "../../../config/sessions/session-accessor.js";
import * as agentDatabaseReadOnly from "../../../state/openclaw-agent-db-readonly.js";
import { listTaskRecords } from "../../../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../../../tasks/task-registry.store.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { createInMemoryTaskRegistryStore } from "../../../test-utils/task-registry-store.js";
import { readGatewayAccessRevision } from "../../gateway-access-revision.js";
import * as gatewayAccess from "../../gateway-access-revision.js";
import { installGatewayTestHooks } from "../../server.auth.test-helpers.js";
import {
  createTaskSnapshot,
  expectedTaskIds,
  expectCursorRejected,
  FOREIGN_SESSION_KEY,
  OWNED_SESSION_KEY,
  type RpcResponse,
  sendRpc,
  TASK_COUNT,
  withAuthenticatedTaskGateway,
} from "../../server.tasks-list.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

afterAll(() => {
  resetTaskRegistryForTests({ persist: false });
});

test("preserves task pagination during metadata patches but invalidates new requester access", async () => {
  const replaceTasks = (tasks: Map<string, TaskRecord>) => {
    resetTaskRegistryForTests({ persist: false });
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: () => ({
          tasks,
          deliveryStates: new Map(),
        }),
      },
    });
  };
  const initializeTasks = () => replaceTasks(new Map([...createTaskSnapshot()].slice(0, 256)));
  await withAuthenticatedTaskGateway(initializeTasks, async ({ admin, viewer }) => {
    const metadataPage = await sendRpc<TasksListResult>(
      viewer,
      "tasks-before-label",
      "tasks.list",
      { limit: 7 },
    );
    expect(metadataPage.ok, JSON.stringify(metadataPage.error)).toBe(true);
    const metadataCursor = metadataPage.payload?.nextCursor;
    if (!metadataCursor) {
      throw new Error("expected a task cursor before the label change");
    }
    const foreignScope = { agentId: "main", sessionKey: FOREIGN_SESSION_KEY };
    const accessFields = (entry: ReturnType<typeof loadSessionEntry>) => ({
      sessionId: entry?.sessionId,
      lifecycleRevision: entry?.lifecycleRevision,
      createdActor: entry?.createdActor,
      visibility: entry?.visibility,
      incognito: entry?.incognito,
    });
    const beforeLabel = loadSessionEntry(foreignScope);
    expect(beforeLabel?.sessionId).toBe("session-foreign");
    let metadataMutationCount = 0;
    const changeLabel = async () => {
      const label = `Task metadata ${metadataMutationCount++}`;
      const changed = await sendRpc<Record<string, unknown>>(
        admin,
        `label-change-${metadataMutationCount}`,
        "sessions.patch",
        {
          key: FOREIGN_SESSION_KEY,
          agentId: "main",
          expectedSessionId: "session-foreign",
          label,
        },
      );
      expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
      const afterLabel = loadSessionEntry(foreignScope);
      expect(afterLabel?.label).toBe(label);
      expect(accessFields(afterLabel)).toEqual(accessFields(beforeLabel));
    };
    await changeLabel();
    const categoryChange = await sendRpc<Record<string, unknown>>(
      admin,
      "register-task-category",
      "sessions.patch",
      {
        key: FOREIGN_SESSION_KEY,
        agentId: "main",
        expectedSessionId: "session-foreign",
        category: "Task metadata category",
      },
    );
    expect(categoryChange.ok, JSON.stringify(categoryChange.error)).toBe(true);
    expect(accessFields(loadSessionEntry(foreignScope))).toEqual(accessFields(beforeLabel));
    const afterLabel = await sendRpc<TasksListResult>(viewer, "tasks-after-label", "tasks.list", {
      cursor: metadataCursor,
      limit: 7,
    });
    expect(afterLabel.ok, JSON.stringify(afterLabel.error)).toBe(true);
    expect(afterLabel.payload?.tasks.map((task) => task.id)).toEqual(
      expectedTaskIds(listTaskRecords(), 7, 7),
    );

    let metadataChurnActive = true;
    const metadataChurn = (async () => {
      while (true) {
        if (!metadataChurnActive) {
          return;
        }
        await changeLabel();
      }
    })();
    let duringLabels: RpcResponse<TasksListResult>;
    try {
      duringLabels = await sendRpc<TasksListResult>(viewer, "tasks-during-labels", "tasks.list", {
        limit: 7,
      });
    } finally {
      metadataChurnActive = false;
      await metadataChurn;
    }
    expect(metadataMutationCount).toBeGreaterThan(1);
    expect(duringLabels.ok, JSON.stringify(duringLabels.error)).toBe(true);
    expect(duringLabels.payload?.tasks.map((task) => task.id)).toEqual(
      expectedTaskIds(listTaskRecords(), 0, 7),
    );

    const metadataTasks = listTaskRecords();
    const missingSessionKey = "agent:main:tasks-missing";
    const missingSessionTask: TaskRecord = {
      ...metadataTasks.find((task) => task.taskId === "task-00000")!,
      taskId: "task-missing-requester",
      requesterSessionKey: missingSessionKey,
      ownerKey: missingSessionKey,
      lastEventAt: TASK_COUNT + 100,
    };
    replaceTasks(
      new Map([...metadataTasks, missingSessionTask].map((task) => [task.taskId, task])),
    );
    const beforeCreation = await sendRpc<TasksListResult>(
      viewer,
      "tasks-before-requester-created",
      "tasks.list",
      { limit: 1 },
    );
    expect(beforeCreation.ok, JSON.stringify(beforeCreation.error)).toBe(true);
    expect(beforeCreation.payload?.tasks[0]?.id).not.toBe(missingSessionTask.taskId);
    const creationCursor = beforeCreation.payload?.nextCursor;
    if (!creationCursor) {
      throw new Error("expected a cursor before requester-session creation");
    }
    const createdSession = await sendRpc<Record<string, unknown>>(
      admin,
      "create-task-requester-with-patch",
      "sessions.patch",
      { key: missingSessionKey, agentId: "main", label: "Created task requester" },
    );
    expect(createdSession.ok, JSON.stringify(createdSession.error)).toBe(true);
    await expectCursorRejected(viewer, "tasks-created-requester-cursor", {
      cursor: creationCursor,
      limit: 1,
    });
    const afterCreation = await sendRpc<TasksListResult>(
      viewer,
      "tasks-after-requester-created",
      "tasks.list",
      { limit: 1 },
    );
    expect(afterCreation.ok, JSON.stringify(afterCreation.error)).toBe(true);
    expect(afterCreation.payload?.tasks[0]?.id).toBe(missingSessionTask.taskId);

    const pageParams = { sessionKey: OWNED_SESSION_KEY, limit: 25 };
    const available = await sendRpc<TasksListResult>(
      viewer,
      "tasks-readable",
      "tasks.list",
      pageParams,
    );
    expect(available.ok, JSON.stringify(available.error)).toBe(true);
    expect(available.payload?.tasks).toHaveLength(25);

    const failure = new Error("session metadata read failed", {
      cause: new Error("SQLITE_IOERR"),
    });
    const readMetadata = sessionAccessor.loadExactSessionEntryCandidatesReadOnlyBatch;
    let failedReads = 0;
    const failingRead = vi
      .spyOn(sessionAccessor, "loadExactSessionEntryCandidatesReadOnlyBatch")
      .mockImplementation((scopes) => {
        const results = readMetadata(scopes);
        if (scopes.some((scope) => scope.sessionKeys.includes(OWNED_SESSION_KEY))) {
          failedReads += 1;
        }
        return results.map((result, index) =>
          scopes[index]?.sessionKeys.includes(OWNED_SESSION_KEY) ? err(failure) : result,
        );
      });
    try {
      const unavailable = await sendRpc<TasksListResult>(
        viewer,
        "tasks-unreadable",
        "tasks.list",
        pageParams,
      );
      expect(unavailable.payload).toBeUndefined();
      expect(unavailable).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: expect.stringContaining("SQLITE_IOERR") },
      });
      expect(failedReads).toBe(1);
    } finally {
      failingRead.mockRestore();
    }

    for (const reason of ["database-missing", "schema-missing"] as const) {
      const unavailableStore = vi
        .spyOn(agentDatabaseReadOnly, "withOpenClawAgentDatabaseReadOnly")
        .mockReturnValue({ found: false, reason });
      try {
        const unavailable = await sendRpc<TasksListResult>(
          viewer,
          `tasks-${reason}`,
          "tasks.list",
          pageParams,
        );
        if (reason === "database-missing") {
          expect(unavailable).toMatchObject({ ok: true, payload: { tasks: [] } });
        } else {
          expect(unavailable.payload).toBeUndefined();
          expect(unavailable).toMatchObject({
            ok: false,
            error: { code: "UNAVAILABLE", message: expect.stringContaining(reason) },
          });
        }
        expect(unavailableStore).toHaveBeenCalled();
      } finally {
        unavailableStore.mockRestore();
      }
    }
    const recovered = await sendRpc<TasksListResult>(
      viewer,
      "tasks-store-recovered",
      "tasks.list",
      pageParams,
    );
    expect(recovered.ok, JSON.stringify(recovered.error)).toBe(true);
    expect(recovered.payload?.tasks).toHaveLength(25);

    const requesterScope = { agentId: "main", sessionKey: OWNED_SESSION_KEY };
    const requesterBeforeChildren = accessFields(loadSessionEntry(requesterScope));
    const tasksBeforeChildren = structuredClone(listTaskRecords());
    const taskRuntime = await import("../../../tasks/runtime-internal.js");
    const selectPage = taskRuntime.listTaskRecordPage;
    const childCreations: Array<{
      accessBeforeSelection: number;
      accessBeforeCreation: number;
      accessAfterCreation: number;
      pageRevision: number;
      currentBeforeCreation: boolean;
      currentAfterCreation: boolean;
      selectedTaskCount: number;
      childSessionKey: string;
      createdStatus: string;
    }> = [];
    // A real child commit exercises the runtime identity listener while task
    // membership and the selected requester remain unchanged.
    const creatingChildren = vi
      .spyOn(taskRuntime, "listTaskRecordPage")
      .mockImplementation(async (params) => {
        const accessBeforeSelection = readGatewayAccessRevision();
        const selected = await selectPage(params);
        if (!selected.ok) {
          return selected;
        }
        const page = selected.value;
        const accessBeforeCreation = readGatewayAccessRevision();
        const currentBeforeCreation = page.isCurrent();
        const childSessionKey = `agent:main:subagent:task-list-child-${childCreations.length}`;
        const created = await createInitialSubagentSession({
          cfg: getRuntimeConfig(),
          targetAgentId: "main",
          childSessionKey,
          incognito: false,
          requesterInternalKey: OWNED_SESSION_KEY,
          creationPolicy: { actor: { type: "agent", id: "main" } },
          completionOwnerSessionKey: OWNED_SESSION_KEY,
          modelPatch: {},
          collect: false,
        });
        childCreations.push({
          accessBeforeSelection,
          accessBeforeCreation,
          accessAfterCreation: readGatewayAccessRevision(),
          pageRevision: page.revision,
          currentBeforeCreation,
          currentAfterCreation: page.isCurrent(),
          selectedTaskCount: page.tasks.length,
          childSessionKey,
          createdStatus: created.status,
        });
        expect(created, JSON.stringify(created)).toMatchObject({ status: "ok" });
        return selected;
      });
    let duringChildren: RpcResponse<TasksListResult>;
    try {
      duringChildren = await sendRpc<TasksListResult>(
        viewer,
        "tasks-during-child-creation",
        "tasks.list",
        pageParams,
      );
      const detail = JSON.stringify({ childCreations, response: duringChildren });
      expect(childCreations.length, detail).toBeGreaterThan(0);
      for (const creation of childCreations) {
        expect(creation.currentBeforeCreation, detail).toBe(true);
        expect(creation.currentAfterCreation, detail).toBe(true);
        expect(
          loadSessionEntry({ agentId: "main", sessionKey: creation.childSessionKey }),
        ).toMatchObject({
          createdVia: "spawn",
          spawnedBy: OWNED_SESSION_KEY,
          parentSessionKey: OWNED_SESSION_KEY,
        });
      }
      expect(accessFields(loadSessionEntry(requesterScope)), detail).toEqual(
        requesterBeforeChildren,
      );
      expect(listTaskRecords(), detail).toEqual(tasksBeforeChildren);
      expect(duringChildren.ok, detail).toBe(true);
      expect(duringChildren.payload?.tasks, detail).toEqual(recovered.payload?.tasks);
    } finally {
      creatingChildren.mockRestore();
    }
    const freshCursor = duringChildren.payload?.nextCursor;
    expect(freshCursor).toEqual(expect.any(String));
    const continuation = await sendRpc<TasksListResult>(
      viewer,
      "tasks-after-unrelated-child-creation",
      "tasks.list",
      { ...pageParams, cursor: freshCursor },
    );
    expect(continuation.ok, JSON.stringify(continuation.error)).toBe(true);
    expect(continuation.payload?.tasks.map((task) => task.id)).toEqual(
      expectedTaskIds(
        tasksBeforeChildren.filter((task) => task.requesterSessionKey === OWNED_SESSION_KEY),
        25,
        25,
      ),
    );

    const missingDuringRead = {
      ...missingSessionTask,
      taskId: "task-requester-created-during-read",
      requesterSessionKey: "agent:main:tasks-requester-created-during-read",
      ownerKey: "agent:main:tasks-requester-created-during-read",
      lastEventAt: TASK_COUNT + 200,
    };
    replaceTasks(
      new Map([...tasksBeforeChildren, missingDuringRead].map((task) => [task.taskId, task])),
    );
    const creatingRequester = vi
      .spyOn(taskRuntime, "listTaskRecordPage")
      .mockImplementationOnce(async (params) => {
        const selected = await selectPage(params);
        expect(selected.ok).toBe(true);
        if (selected.ok) {
          expect(
            selected.value.tasks.some((task) => task.taskId === missingDuringRead.taskId),
          ).toBe(false);
        }
        await sessionAccessor.upsertSessionEntryCore(
          { agentId: "main", sessionKey: missingDuringRead.requesterSessionKey },
          {
            sessionId: "new-requester",
            lifecycleRevision: "new-requester-generation",
            updatedAt: 1,
          },
        );
        return selected;
      });
    try {
      const withRequester = await sendRpc<TasksListResult>(
        viewer,
        "tasks-created-requester-during-read",
        "tasks.list",
        { limit: 1 },
      );
      expect(withRequester.ok, JSON.stringify(withRequester.error)).toBe(true);
      expect(withRequester.payload?.tasks[0]?.id).toBe(missingDuringRead.taskId);
    } finally {
      creatingRequester.mockRestore();
    }

    const scopes: Array<ReturnType<typeof gatewayAccess.createGatewayAccessReadScope>> = [];
    const createScope = gatewayAccess.createGatewayAccessReadScope;
    const observedScopes = vi
      .spyOn(gatewayAccess, "createGatewayAccessReadScope")
      .mockImplementation(() => {
        const scope = createScope();
        scopes.push(scope);
        return scope;
      });
    const failedSelection = vi
      .spyOn(taskRuntime, "listTaskRecordPage")
      .mockRejectedValueOnce(new Error("Synthetic task selection failed"));
    try {
      const failed = await sendRpc<TasksListResult>(
        viewer,
        "tasks-selection-error",
        "tasks.list",
        pageParams,
      );
      expect(failed).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
      const recoveredScope = await sendRpc<TasksListResult>(
        viewer,
        "tasks-selection-recovered",
        "tasks.list",
        pageParams,
      );
      expect(recoveredScope.ok, JSON.stringify(recoveredScope.error)).toBe(true);
      expect(scopes).toHaveLength(2);
      expect(scopes.every((scope) => !scope.isCurrent())).toBe(true);
    } finally {
      failedSelection.mockRestore();
      observedScopes.mockRestore();
    }

    replaceTasks(
      new Map([
        [
          "task-requester-alias",
          {
            ...missingSessionTask,
            taskId: "task-requester-alias",
            requesterSessionKey: "tasks-owned",
            ownerKey: OWNED_SESSION_KEY,
          },
        ],
      ]),
    );
    const aliasPage = await sendRpc<TasksListResult>(
      viewer,
      "tasks-alias-before-creation",
      "tasks.list",
      { limit: 1 },
    );
    expect(aliasPage.payload?.tasks[0]?.id).toBe("task-requester-alias");
    let aliasCreations = 0;
    const creatingBesideAlias = vi
      .spyOn(taskRuntime, "listTaskRecordPage")
      .mockImplementation(async (params) => {
        const selected = await selectPage(params);
        await sessionAccessor.upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:alias-neighbor-${aliasCreations++}` },
          { sessionId: `alias-neighbor-${aliasCreations}`, updatedAt: 1 },
        );
        return selected;
      });
    try {
      const ambiguous = await sendRpc<TasksListResult>(
        viewer,
        "tasks-alias-during-creation",
        "tasks.list",
        { limit: 1 },
      );
      expect(aliasCreations).toBeGreaterThan(0);
      expect(ambiguous).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Task activity did not stabilize. Wait a moment, then refresh Tasks.",
        },
      });
    } finally {
      creatingBesideAlias.mockRestore();
    }
  });
}, 60_000);
