import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { runExclusiveSqliteSessionWrite } from "../config/sessions/session-accessor.sqlite-scope.js";
import { readAgentDeletionJournalStatusInWorker } from "../state/agent-deletion-journal.read.js";
import {
  beginSessionEffect,
  closeAgentWorkAdmissions,
  closeSessionControllerAdmission,
  collectActiveAgentSessionWorkAdmissions,
  startAgentWorkAdmissionInterruption,
  startSessionControllerInterruption,
} from "./session-controller.lifecycle.js";

// mock-isolation: Admission decisions use controlled journal status without opening SQLite.
vi.mock("../state/agent-deletion-journal.read.js", () => ({
  readAgentDeletionJournalStatusInWorker: vi.fn(async () => "absent"),
}));

it("refuses queued session writes when deletion closes admission before their FIFO turn", async () => {
  const target = { agentId: "worker", env: { OPENCLAW_STATE_DIR: "/agent-write-admission" } };
  const entered = createDeferred();
  const release = createDeferred();
  const holding = runExclusiveSqliteSessionWrite(
    target,
    async () => {
      entered.resolve();
      await release.promise;
    },
    "session-entry.patch",
  );
  await awaitGateBeforeSettlement(entered.promise, holding, "writer did not reserve its FIFO");
  const write = vi.fn(async () => {});
  const queued = runExclusiveSqliteSessionWrite(target, write, "session-entry.patch");
  const reason = new Error("agent deletion began");
  const refused = expect(queued).rejects.toBe(reason);
  const reopen = closeAgentWorkAdmissions({ ...target, reason });
  try {
    release.resolve();
    await holding;
    await refused;
    expect(write).not.toHaveBeenCalled();
    await expect(
      runExclusiveSqliteSessionWrite(
        { ...target, agentId: "kept" },
        async () => "saved",
        "session-entry.patch",
      ),
    ).resolves.toBe("saved");
  } finally {
    release.resolve();
    await Promise.allSettled([holding, queued]);
    reopen();
  }
  await runExclusiveSqliteSessionWrite(target, write, "session-entry.patch");
  expect(write).toHaveBeenCalledOnce();
});

it("fences unseen agent sessions and joins exact admitted work without blocking another state", async () => {
  const target = { agentId: "worker", env: { OPENCLAW_STATE_DIR: "/agent-admission-state-a" } };
  const scope = "agent:worker";
  const interrupted = createDeferred();
  const active = await beginSessionEffect({
    ...target,
    scope,
    identities: ["sessionless-run"],
    assertAllowed: () => {},
    onInterrupt: () => interrupted.resolve(),
  });
  const releaseActive = createDeferred();
  const activeWork = active.run(async () => await releaseActive.promise);
  const pendingStarted = createDeferred();
  const releasePending = createDeferred();
  const pending = beginSessionEffect({
    ...target,
    scope,
    identities: ["pending-run"],
    assertAllowed: async () => {
      pendingStarted.resolve();
      await releasePending.promise;
    },
    revalidateAllowed: () => {},
  });
  const reason = new Error("agent deletion began");
  const pendingOutcome = expect(pending).rejects.toBe(reason);
  await pendingStarted.promise;
  const reopen = closeAgentWorkAdmissions({ ...target, reason });
  let other: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
  try {
    const onInterrupt = vi.fn();
    await expect(
      beginSessionEffect({
        ...target,
        scope: "previously-unseen-store",
        identities: ["new-session"],
        assertAllowed: () => {},
        onInterrupt,
      }),
    ).rejects.toBe(reason);
    expect(onInterrupt).not.toHaveBeenCalled();
    other = await beginSessionEffect({
      ...target,
      env: { OPENCLAW_STATE_DIR: "/agent-admission-state-b" },
      scope,
      identities: ["same-agent-other-state"],
      assertAllowed: () => {},
    });
    expect(collectActiveAgentSessionWorkAdmissions(target).get(scope)).toEqual(
      new Set(["sessionless-run"]),
    );
    const drain = startAgentWorkAdmissionInterruption({ ...target, reason });
    await interrupted.promise;
    let settled = false;
    void drain.released.then(() => {
      settled = true;
    });
    const forbiddenWork = vi.fn(async () => {});
    await expect(active.run(forbiddenWork)).rejects.toBe(reason);
    expect(forbiddenWork).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    releasePending.resolve();
    await pendingOutcome;
    active.release();
    await Promise.resolve();
    expect(settled).toBe(false);
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
  vi.mocked(readAgentDeletionJournalStatusInWorker).mockResolvedValueOnce("pending");
  let admitted: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
  try {
    await expect(
      beginSessionEffect({
        agentId: "worker",
        env: { OPENCLAW_STATE_DIR: "/agent-admission-restart" },
        scope: "agent:worker",
        identities: ["new-run-after-restart"],
        assertAllowed: () => {},
      }).then((lease) => {
        admitted = lease;
        return lease;
      }),
    ).rejects.toThrow("deletion is in progress");
  } finally {
    admitted?.release();
  }
});

it.each(["session-first", "agent-first"] as const)(
  "keeps agent deletion refusal ahead of an overlapping session Stop (%s)",
  async (order) => {
    const target = {
      agentId: "worker",
      env: { OPENCLAW_STATE_DIR: "/agent-admission-overlap" },
      scope: "overlapping-stop.sqlite",
      identities: ["stopped-session"],
    };
    const agentReason = new Error("agent deletion is pending");
    const close = [
      () => closeSessionControllerAdmission({ ...target, reason: new Error("session stopped") }),
      () => closeAgentWorkAdmissions({ ...target, reason: agentReason }),
    ];
    const reopen = (order === "session-first" ? close : close.toReversed()).map((stop) => stop());
    const onInterrupt = vi.fn();
    try {
      await expect(
        beginSessionEffect({ ...target, assertAllowed: () => {}, onInterrupt }),
      ).rejects.toBe(agentReason);
      expect(onInterrupt).not.toHaveBeenCalled();
    } finally {
      for (const release of reopen) {
        release();
      }
    }
  },
);

it("refuses deletion from the target agent's own admitted turn before closing ingress", async () => {
  const target = { agentId: "worker", env: { OPENCLAW_STATE_DIR: "/agent-admission-self-delete" } };
  const params = {
    ...target,
    scope: "agent:worker",
    identities: ["self-delete-turn"],
    assertAllowed: () => {},
  };
  const active = await beginSessionEffect(params);
  try {
    await expect(
      active.run(async () => closeAgentWorkAdmissions({ ...target, reason: new Error("delete") })),
    ).rejects.toThrow("Cannot delete an agent from its own active turn");
    const following = await beginSessionEffect({
      ...params,
      identities: ["following-turn"],
    });
    following.release();
    expect(active.isActive()).toBe(true);
  } finally {
    active.release();
  }
});

it.each(["agent", "session"] as const)(
  "rechecks %s drain authority between admitted cancellations",
  async (scope) => {
    const target = {
      agentId: "worker",
      env: { OPENCLAW_STATE_DIR: "/agent-admission-revoked" },
      scope: "agent:worker",
      identities: ["shared-session"],
      assertAllowed: () => {},
    };
    let current = true;
    const first = await beginSessionEffect({
      ...target,
      onInterrupt: () => {
        current = false;
      },
    });
    const laterInterrupt = vi.fn();
    const later = await beginSessionEffect({ ...target, onInterrupt: laterInterrupt });
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
          ? startAgentWorkAdmissionInterruption({ ...target, assertCurrent })
          : startSessionControllerInterruption({ ...target, assertCurrent });
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
