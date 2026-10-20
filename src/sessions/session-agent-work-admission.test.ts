import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { runExclusiveSqliteSessionWrite as writeSession } from "../config/sessions/session-accessor.sqlite-scope.js";
import { readAgentDeletionJournalStatusInWorker } from "../state/agent-deletion-journal.read.js";
import {
  beginSessionEffect,
  closeAgentWorkAdmissions as closeAgent,
  closeSessionControllerAdmission as closeSession,
  collectActiveAgentSessionWorkAdmissions,
  startAgentWorkAdmissionInterruption as interruptAgent,
  startSessionControllerInterruption as interruptSession,
} from "./session-controller.lifecycle.js";

// mock-isolation: Admission decisions use controlled journal status without opening SQLite.
vi.mock("../state/agent-deletion-journal.read.js", () => ({
  readAgentDeletionJournalStatusInWorker: vi.fn(async () => "absent"),
}));

function fixture(state: string, scope = "agent:worker") {
  const target = { agentId: "worker", env: { OPENCLAW_STATE_DIR: state } };
  const session = (id: string) => ({ ...target, scope, identities: [id] });
  const begin = (id: string, overrides: Partial<Parameters<typeof beginSessionEffect>[0]> = {}) =>
    beginSessionEffect({ ...session(id), assertAllowed: () => {}, ...overrides });
  const write = <T>(operation: () => Promise<T>, agentId = "worker") =>
    writeSession({ ...target, agentId }, operation, "session-entry.patch");
  return { target, session, begin, write };
}

it("refuses queued session writes when deletion closes admission before their FIFO turn", async () => {
  const { target, write: runWrite } = fixture("/agent-write-admission");
  const entered = createDeferred();
  const release = createDeferred();
  const holding = runWrite(async () => {
    entered.resolve();
    await release.promise;
  });
  await awaitGateBeforeSettlement(entered.promise, holding, "writer did not reserve its FIFO");
  const write = vi.fn(async () => {});
  const queued = runWrite(write);
  const reason = new Error("agent deletion began");
  const refused = expect(queued).rejects.toBe(reason);
  const reopen = closeAgent({ ...target, reason });
  try {
    release.resolve();
    await holding;
    await refused;
    expect(write).not.toHaveBeenCalled();
    await expect(runWrite(async () => "saved", "kept")).resolves.toBe("saved");
  } finally {
    release.resolve();
    await Promise.allSettled([holding, queued]);
    reopen();
  }
  await runWrite(write);
  expect(write).toHaveBeenCalledOnce();
});

it("fences unseen agent sessions and joins exact admitted work without blocking another state", async () => {
  const { target, begin } = fixture("/agent-admission-state-a");
  const scope = "agent:worker";
  const interrupted = createDeferred();
  const active = await begin("sessionless-run", { onInterrupt: () => interrupted.resolve() });
  const releaseActive = createDeferred();
  const activeWork = active.run(async () => await releaseActive.promise);
  const pendingStarted = createDeferred();
  const releasePending = createDeferred();
  const pending = begin("pending-run", {
    assertAllowed: async () => {
      pendingStarted.resolve();
      await releasePending.promise;
    },
    revalidateAllowed: () => {},
  });
  const reason = new Error("agent deletion began");
  const pendingOutcome = expect(pending).rejects.toBe(reason);
  await pendingStarted.promise;
  const reopen = closeAgent({ ...target, reason });
  let other: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
  try {
    const onInterrupt = vi.fn();
    await expect(
      begin("new-session", {
        scope: "previously-unseen-store",
        onInterrupt,
      }),
    ).rejects.toBe(reason);
    expect(onInterrupt).not.toHaveBeenCalled();
    other = await begin("same-agent-other-state", {
      env: { OPENCLAW_STATE_DIR: "/agent-admission-state-b" },
    });
    expect(collectActiveAgentSessionWorkAdmissions(target).get(scope)).toEqual(
      new Set(["sessionless-run"]),
    );
    const drain = interruptAgent({ ...target, reason });
    await interrupted.promise;
    const settled = vi.fn();
    void drain.released.then(settled);
    const forbiddenWork = vi.fn(async () => {});
    await expect(active.run(forbiddenWork)).rejects.toBe(reason);
    expect(forbiddenWork).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    releasePending.resolve();
    await pendingOutcome;
    active.release();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    releaseActive.resolve();
    await activeWork;
    await drain.released;
    expect(other.isActive()).toBe(true);
  } finally {
    releasePending.resolve();
    releaseActive.resolve();
    await pending.catch(() => {});
    await activeWork;
    active.release();
    other?.release();
    reopen();
  }
});

it("rejects new agent work after a durable deletion survives restart", async () => {
  const { begin } = fixture("/agent-admission-restart");
  vi.mocked(readAgentDeletionJournalStatusInWorker).mockResolvedValueOnce("pending");
  const attempt = begin("new-run-after-restart");
  try {
    await expect(attempt).rejects.toThrow("deletion is in progress");
  } finally {
    (await attempt.catch(() => undefined))?.release();
  }
});

it.each(["session-first", "agent-first"] as const)(
  "keeps agent deletion refusal ahead of an overlapping session Stop (%s)",
  async (order) => {
    const { session, begin } = fixture("/agent-admission-overlap", "overlapping-stop.sqlite");
    const target = session("stopped-session");
    const agentReason = new Error("agent deletion is pending");
    const close = [
      () => closeSession({ ...target, reason: new Error("session stopped") }),
      () => closeAgent({ ...target, reason: agentReason }),
    ];
    const reopen = (order === "session-first" ? close : close.toReversed()).map((stop) => stop());
    const onInterrupt = vi.fn();
    try {
      await expect(begin("stopped-session", { onInterrupt })).rejects.toBe(agentReason);
      expect(onInterrupt).not.toHaveBeenCalled();
    } finally {
      for (const release of reopen) {
        release();
      }
    }
  },
);

it("refuses deletion from the target agent's own admitted turn before closing ingress", async () => {
  const { target, begin } = fixture("/agent-admission-self-delete");
  const active = await begin("self-delete-turn");
  try {
    await expect(
      active.run(async () => closeAgent({ ...target, reason: new Error("delete") })),
    ).rejects.toThrow("Cannot delete an agent from its own active turn");
    const following = await begin("following-turn");
    following.release();
    expect(active.isActive()).toBe(true);
  } finally {
    active.release();
  }
});

it.each(["agent", "session"] as const)(
  "rechecks %s drain authority between admitted cancellations",
  async (scope) => {
    const { session, begin } = fixture("/agent-admission-revoked");
    const target = session("shared-session");
    let current = true;
    const first = await begin("shared-session", {
      onInterrupt: () => {
        current = false;
      },
    });
    const laterInterrupt = vi.fn();
    const later = await begin("shared-session", { onInterrupt: laterInterrupt });
    const releaseCleanup = createDeferred();
    const cleanup = first.run(async () => await releaseCleanup.promise);
    const assertCurrent = () => {
      if (!current) {
        throw new Error("deletion journal replaced");
      }
    };
    try {
      const drain =
        scope === "agent"
          ? interruptAgent({ ...target, assertCurrent })
          : interruptSession({ ...target, assertCurrent });
      const settled = vi.fn();
      void drain.released.then(settled, settled);
      expect(settled).not.toHaveBeenCalled();
      expect(laterInterrupt).not.toHaveBeenCalled();
      expect(later.isActive()).toBe(true);
      first.release();
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      releaseCleanup.resolve();
      await cleanup;
      await expect(drain.released).rejects.toThrow("deletion journal replaced");
    } finally {
      releaseCleanup.resolve();
      await cleanup;
      first.release();
      later.release();
    }
  },
);
