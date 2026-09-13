// Projection eligibility uses the existing admitted lifetime, not new native authority.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TriageBackingReference } from "../infra/triage-backing.js";
import { startTriageRepairTask } from "./triage-task.js";

const mocks = vi.hoisted(() => ({ observe: vi.fn(), create: vi.fn(), find: vi.fn() }));
vi.mock("../infra/triage-backing.js", () => ({ observeTriageBacking: mocks.observe }));
vi.mock("../tasks/detached-task-runtime.js", () => ({ createRunningTaskRun: mocks.create }));
vi.mock("../tasks/task-status-access.js", () => ({ findTaskByRunIdForStatus: mocks.find }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.observe.mockReturnValue({
    kind: "matched",
    phase: "running",
    helper: "live",
    executor: "live",
    lifetime: "matched",
    control: "unavailable",
  });
  mocks.create.mockImplementation((request) => ({
    taskId: "task-1",
    status: "running",
    createdAt: Date.now(),
    ...request,
  }));
});
afterEach(() => vi.restoreAllMocks());

it.each(["foreground", "native"] as const)(
  "only projects %s admission when an original parent can settle it",
  (kind) => {
    const backing: TriageBackingReference = {
      kind: "triage",
      installationRoot: "/fixture/package",
      leaseDatabase: {
        databasePath: "/fixture/lease.sqlite",
        databaseIdentity: "1:2",
        parentIdentity: "1:1",
      },
      generation: {
        version: 2,
        owner: "generation-1",
        helper: { pid: 100, startIdentity: "helper" },
        executor: { pid: 101, startIdentity: "executor" },
        lifetime:
          kind === "foreground"
            ? {
                kind,
                boot: { platform: "linux", identity: "00000000-0000-0000-0000-000000000001" },
              }
            : {
                kind,
                unit: "fixture.service",
                scope: "user",
                placement: { kind: "attached", invocation: "a".repeat(32) },
              },
      },
    };
    const assertCurrent = vi.fn();
    const taskId = startTriageRepairTask({
      backing,
      signal: new AbortController().signal,
      assertCurrent,
    });
    expect(assertCurrent).toHaveBeenCalled();
    expect(taskId).toBe(kind === "foreground" ? "task-1" : undefined);
    expect(mocks.create).toHaveBeenCalledTimes(kind === "foreground" ? 2 : 0);
  },
);
