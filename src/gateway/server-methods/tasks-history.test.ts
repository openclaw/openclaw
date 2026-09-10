import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { deleteTaskRecordById } from "../../tasks/runtime-internal.js";
import { reloadTaskRegistryFromStore } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { seedTaskRegistryRowsForTests } from "../../test-utils/task-registry-sqlite.js";
import { rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createSnapshotTask, identifiedClient, runTaskHandler } from "./tasks.test-helpers.js";

const catalog = vi.hoisted(() => ({ providers: [] as SessionCatalogProvider[] }));
vi.mock("./session-catalog-provider-access.js", () => ({
  catalogRegistrationSnapshot: () => catalog,
  allowProcessHomeFallback: () => false,
}));

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
const task = createSnapshotTask({
  taskId: "native-task",
  taskKind: "fixture-native",
  runtime: "subagent",
  runId: "native-child",
  requesterAgentId: "main",
});
const read = vi.fn<NonNullable<SessionCatalogProvider["taskHistory"]>["read"]>();
const provider: SessionCatalogProvider = {
  id: "fixture",
  label: "Fixture",
  list: async () => [],
  read: async () => {
    throw new Error("Generic catalog must not be used");
  },
  taskHistory: { taskKinds: ["fixture-native"], read },
};

beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  resetTaskRegistryForTests({ persist: false });
  seedTaskRegistryRowsForTests([task]);
  reloadTaskRegistryFromStore();
  catalog.providers = [provider];
  read.mockReset().mockResolvedValue({
    hostId: "fixture-local",
    threadId: "native-child",
    items: [{ id: "output", type: "agentMessage", text: "Child progress" }],
    nextCursor: "older-page",
  });
});
afterEach(async () => {
  catalog.providers = [];
  resetTaskRegistryForTests({ persist: false });
  await state.cleanup();
});

describe("task-scoped native history", () => {
  it("advertises and reads the authorized task with server-owned scope and pagination", async () => {
    const detail = await runTaskHandler("tasks.get", { taskId: task.taskId });
    expect(detail.payload?.task?.transcriptAvailable).toBe(true);
    const result = await runTaskHandler("tasks.history", {
      taskId: task.taskId,
      limit: 10,
      cursor: "anchor",
    });
    expect(result.calls[0]?.[0]).toBe(true);
    expect(result.payload?.items).toEqual([
      { id: "output", type: "agentMessage", text: "Child progress" },
    ]);
    expect(result.payload?.nextCursor).toBe("older-page");
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.taskId,
        taskKind: task.taskKind,
        runId: task.runId,
        requesterSessionKey: task.requesterSessionKey,
        ownerKey: task.ownerKey,
        cursor: "anchor",
        limit: 10,
        allowProcessHomeFallback: false,
      }),
    );
  });

  it.each([
    { threadId: "another-child" },
    { hostId: "another-home" },
    { limit: 101 },
    { cursor: "x".repeat(16385) },
  ])("rejects client native locators and unbounded requests: %j", async (extra) => {
    const result = await runTaskHandler("tasks.history", { taskId: task.taskId, ...extra });
    expect(result.calls[0]?.[0]).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it("never reads a private requester's native history for another operator", async () => {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: task.requesterSessionKey },
      {
        sessionId: "parent",
        updatedAt: 1,
        visibility: "draft",
      },
    );
    const result = await runTaskHandler(
      "tasks.history",
      { taskId: task.taskId },
      rolePolicyConfig(),
      identifiedClient(["operator.read"], ensureProfileForEmail("viewer@example.test").id),
    );
    expect(result.calls[0]?.[0]).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["deleted", "provider-retired", "owner-changed", "sharing-revoked"] as const)(
    "discards awaited history when %s",
    async (change) => {
      const config = rolePolicyConfig();
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: task.requesterSessionKey },
        {
          sessionId: "parent",
          updatedAt: 1,
          visibility: "shared",
        },
      );
      read.mockImplementationOnce(async () => {
        if (change === "deleted") {
          deleteTaskRecordById(task.taskId);
        }
        if (change === "provider-retired") {
          catalog.providers = [];
        }
        if (change === "owner-changed") {
          seedTaskRegistryRowsForTests([{ ...task, runId: "replacement-child" }]);
          reloadTaskRegistryFromStore();
        }
        if (change === "sharing-revoked") {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: task.requesterSessionKey },
            {
              sessionId: "parent",
              updatedAt: 2,
              visibility: "draft",
            },
          );
        }
        return {
          hostId: "fixture",
          threadId: "child",
          items: [{ id: "revoked", type: "agentMessage", text: "revoked output" }],
        };
      });
      const result = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId },
        config,
        identifiedClient(["operator.read"], ensureProfileForEmail("viewer@example.test").id),
      );
      expect(read).toHaveBeenCalledOnce();
      expect(result.calls[0]?.[0]).toBe(false);
      expect(result.calls[0]?.[1]).toBeUndefined();
    },
  );

  it("does not route ambiguous plugin claims or ordinary child sessions", async () => {
    catalog.providers = [provider, { ...provider, id: "other" }];
    expect(
      (await runTaskHandler("tasks.get", { taskId: task.taskId })).payload?.task
        ?.transcriptAvailable,
    ).toBeUndefined();
    expect((await runTaskHandler("tasks.history", { taskId: task.taskId })).calls[0]?.[0]).toBe(
      false,
    );
    catalog.providers = [provider];
    seedTaskRegistryRowsForTests([{ ...task, childSessionKey: "agent:main:subagent:child" }]);
    reloadTaskRegistryFromStore();
    expect((await runTaskHandler("tasks.history", { taskId: task.taskId })).calls[0]?.[0]).toBe(
      false,
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("omits private reasoning and provider raw payloads", async () => {
    read.mockResolvedValueOnce({
      hostId: "fixture",
      threadId: "child",
      items: [
        { id: "private", type: "reasoning", text: "private", raw: { content: "private" } },
        { id: "visible", type: "agentMessage", text: "Visible", raw: { hidden: "private" } },
      ],
    });
    const result = await runTaskHandler("tasks.history", { taskId: task.taskId });
    expect(result.payload?.items).toEqual([
      { id: "visible", type: "agentMessage", text: "Visible" },
    ]);
  });

  it("fails closed on oversized results and never echoes provider errors", async () => {
    read.mockResolvedValueOnce({
      hostId: "fixture",
      threadId: "child",
      items: [{ id: "large", type: "agentMessage", text: "x".repeat(20 * 1024 * 1024) }],
    });
    expect((await runTaskHandler("tasks.history", { taskId: task.taskId })).calls[0]?.[0]).toBe(
      false,
    );
    read.mockRejectedValueOnce(new Error("private provider connection details"));
    const result = await runTaskHandler("tasks.history", { taskId: task.taskId });
    expect(result.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(result.calls)).not.toContain("private provider");
  });

  it.each(["missing", "empty"])(
    "rejects %s item identity before live history can accumulate duplicates",
    async (kind) => {
      const item = { id: "output", type: "agentMessage" as const, text: "Child progress" };
      if (kind === "missing") {
        Reflect.deleteProperty(item, "id");
      } else {
        item.id = "";
      }
      read.mockResolvedValueOnce({ hostId: "fixture", threadId: "child", items: [item] });
      const result = await runTaskHandler("tasks.history", { taskId: task.taskId });
      expect(result.calls[0]?.[0]).toBe(false);
      expect(result.calls[0]?.[1]).toBeUndefined();
    },
  );
});
