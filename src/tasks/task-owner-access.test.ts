import { afterEach, describe, expect, it } from "vitest";
import {
  findLatestTaskForRelatedSessionKeyForOwner,
  findTaskByRunIdForOwner,
  getTaskByIdForOwner,
  resolveTaskForLookupTokenForOwner,
} from "./task-owner-access.js";
import { createTaskRecord, resetTaskRegistryForTests } from "./task-registry.js";

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
});

describe("task owner access", () => {
  it("returns owner-scoped tasks for owner and child-session lookups", () => {
    const task = createTaskRecord({
      runtime: "subagent",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:child-1",
      runId: "owner-visible-run",
      task: "Owner visible task",
      status: "running",
    });

    expect(
      findLatestTaskForRelatedSessionKeyForOwner({
        relatedSessionKey: "agent:main:subagent:child-1",
        callerOwnerKey: "agent:main:main",
      })?.taskId,
    ).toBe(task.taskId);
    expect(
      findTaskByRunIdForOwner({
        runId: "owner-visible-run",
        callerOwnerKey: "agent:main:main",
      })?.taskId,
    ).toBe(task.taskId);
  });

  it("denies cross-owner task reads", () => {
    const task = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:acp:child-1",
      runId: "owner-hidden-run",
      task: "Hidden task",
      status: "queued",
    });

    expect(
      getTaskByIdForOwner({
        taskId: task.taskId,
        callerOwnerKey: "agent:main:subagent:other-parent",
      }),
    ).toBeUndefined();
    expect(
      findTaskByRunIdForOwner({
        runId: "owner-hidden-run",
        callerOwnerKey: "agent:main:subagent:other-parent",
      }),
    ).toBeUndefined();
    expect(
      resolveTaskForLookupTokenForOwner({
        token: "agent:main:acp:child-1",
        callerOwnerKey: "agent:main:subagent:other-parent",
      }),
    ).toBeUndefined();
  });

  it("requires an exact owner-key match", () => {
    const task = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:MixedCase",
      scopeKind: "session",
      runId: "case-sensitive-owner-run",
      task: "Case-sensitive owner",
      status: "queued",
    });

    expect(
      getTaskByIdForOwner({
        taskId: task.taskId,
        callerOwnerKey: "agent:main:mixedcase",
      }),
    ).toBeUndefined();
  });

  it("does not expose system-owned tasks through owner-scoped readers", () => {
    const task = createTaskRecord({
      runtime: "cron",
      ownerKey: "system:cron:nightly",
      scopeKind: "system",
      childSessionKey: "agent:main:cron:nightly",
      runId: "system-task-run",
      task: "Nightly cron",
      status: "running",
      deliveryStatus: "not_applicable",
    });

    expect(
      getTaskByIdForOwner({
        taskId: task.taskId,
        callerOwnerKey: "agent:main:main",
      }),
    ).toBeUndefined();
    expect(
      resolveTaskForLookupTokenForOwner({
        token: "system-task-run",
        callerOwnerKey: "agent:main:main",
      }),
    ).toBeUndefined();
  });
});
