import { afterEach, expect, it, vi } from "vitest";
import * as toast from "../../lib/toast.ts";
import {
  holdPreferenceClear,
  acceptIdlePlacement,
  chooseModel,
  resetWorktreeMocks,
  startAcceptedWorktree,
  acceptedNameWarning,
  preferenceGate,
} from "./draft-worktree-checks.test-support.ts";
import { identityPreferences } from "./draft-worktree-preferences.test-support.ts";
import {
  acceptedWorktreeSession,
  disposeWorktreeDraft,
  readyPreferenceDraft,
  selectCloudWorktree,
} from "./draft-worktree-submission.test-support.ts";
import { decodeIdentityPreferences } from "./preferences.ts";

afterEach(resetWorktreeMocks);

const acceptedWarnings = (warning: { mock: { calls: Parameters<typeof toast.showToast>[] } }) =>
  warning.mock.calls.filter(
    ([notice]) =>
      typeof notice.message === "string" && notice.message.startsWith("Session accepted,"),
  );

const models = ["gpt-5.6-luna", "gpt-5.6-sol"].map((id) => ({ id, name: id, provider: "openai" }));
const decodePreference = (entry: unknown) =>
  decodeIdentityPreferences({ "new-session.v1:main": entry });
const hasPreference = (entry: unknown, key: string, value: string) =>
  entry !== null && typeof entry === "object" && Reflect.get(entry, key) === value;

async function independentDrafts(prefs: ReturnType<typeof identityPreferences>, sequential = true) {
  const first = sequential ? await readyPreferenceDraft(prefs) : prefs.make();
  const next = prefs.make();
  expect(first.context.gateway).not.toBe(next.context.gateway);
  expect(first.context.gateway.snapshot.client).not.toBe(next.context.gateway.snapshot.client);
  expect(first.context.gateway.snapshot.selfUser?.id).toBe(
    next.context.gateway.snapshot.selfUser?.id,
  );
  if (!sequential) {
    await prefs.ready(first);
  }
  await prefs.ready(next);
  return { first, next };
}

it.each(["repository", "model", "empty base", "base before read"] as const)(
  "reconciles independent intent: %s",
  async (change) => {
    const prefs = identityPreferences(
      true,
      change === "base before read" ? undefined : async () => ({ models }),
    );
    const { first, next } = await independentDrafts(prefs);
    const { started, release, wait } = preferenceGate();
    if (change === "base before read") {
      vi.mocked(first.context.sessions.createResult).mockImplementation(async () => {
        await wait();
        return acceptedWorktreeSession;
      });
    } else {
      holdPreferenceClear(prefs, true, { started, release });
      vi.mocked(first.context.sessions.createResult).mockResolvedValue(acceptedWorktreeSession);
    }
    const warning =
      change === "model" || change === "empty base"
        ? vi.spyOn(toast, "showToast").mockReturnValue(false)
        : undefined;
    first.flow.setMessage("first task");
    const submitting = first.flow.submit(undefined, true);
    let newer: unknown;
    try {
      await started.promise;
      if (change === "repository") {
        next.place.applyFolder("/other-repo");
        await vi.waitFor(() => expect(prefs.stored()).toMatchObject({ folder: "/other-repo" }));
        next.place.setWorktreeName("next-task");
      }
      if (change === "repository" || change === "model") {
        await chooseModel(next);
        await vi.waitFor(() =>
          expect(prefs.stored()).toMatchObject({
            model: "openai/gpt-5.6-sol",
            ...(change === "repository"
              ? { folder: "/other-repo", worktreeName: "next-task" }
              : {}),
          }),
        );
      } else {
        next.place.setBaseRef("");
        await vi.waitFor(() => expect(prefs.stored()).toMatchObject({ baseRef: "" }));
      }
      newer = structuredClone(prefs.stored());
      if (change === "base before read") {
        const { invalidateUserPreferences } = await import("../../app/user-prefs-cache.ts");
        invalidateUserPreferences(first.context.gateway.snapshot.client!);
      }
    } finally {
      release.resolve();
      await submitting;
    }
    expect(first.context.sessions.createResult).toHaveBeenCalledOnce();
    expect(next.context.sessions.createResult).not.toHaveBeenCalled();
    expect(first.flow.error).toBeNull();
    if (warning) {
      expect(acceptedWarnings(warning)).toEqual([]);
    }
    if (change === "model") {
      expect(prefs.stored()).toMatchObject({ worktreeName: "", model: "openai/gpt-5.6-sol" });
      expect(decodePreference(prefs.stored())).toEqual(
        decodePreference({ ...(newer as object), worktreeName: "" }),
      );
    } else {
      expect(prefs.stored()).toEqual(newer);
    }
    if (change === "repository") {
      expect(first.place.worktreeName).toBe("");
    }
  },
);

it.each(["accepted clear", "ordinary edit"] as const)(
  "bounds %s contention without replaying creation",
  async (operation) => {
    const prefs = identityPreferences();
    const { first, next } = await independentDrafts(prefs);
    const accepted = operation === "accepted clear";
    let attempts = 0;
    prefs.beforeSave.mockImplementation(async ({ entries }) => {
      const entry = entries["new-session.v1:main"];
      if (hasPreference(entry, accepted ? "worktreeName" : "baseRef", accepted ? "" : "release")) {
        attempts += 1;
        await prefs.publish(next, { thinkingLevel: `concurrent-${attempts}` });
      }
    });
    const warning = vi.spyOn(toast, "showToast").mockReturnValue(false);
    if (accepted) {
      await startAcceptedWorktree(first);
      expect(first.context.sessions.createResult).toHaveBeenCalledOnce();
      expect(first.flow.error).toBeNull();
      expect(acceptedWarnings(warning)).toEqual([[acceptedNameWarning]]);
    } else {
      const writes = vi.spyOn(first.gateway, "persistPreference");
      first.place.setBaseRef("release");
      await Promise.all(writes.mock.results.map((result) => result.value));
      expect(first.context.sessions.createResult).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledExactlyOnceWith({
        message:
          "Saving your new-session choices could not be confirmed. Check them before starting a session.",
      });
    }
    expect(attempts).toBe(3);
    expect(prefs.stored()).toMatchObject({
      worktreeName: "first-task",
      baseRef: "main",
      thinkingLevel: "concurrent-3",
    });
  },
);

it.each(["explicit", "implicit", "cleared"] as const)(
  "restores creating placement with %s base",
  async (base) => {
    const prefs = identityPreferences();
    let first = await readyPreferenceDraft(prefs);
    const independent = base === "cleared" ? await readyPreferenceDraft(prefs) : undefined;
    if (base === "implicit") {
      first.place.setBaseRef("");
      await vi.waitFor(() => expect(prefs.stored()).toMatchObject({ baseRef: "" }));
      disposeWorktreeDraft(first);
      first = await readyPreferenceDraft(prefs);
      expect(first.place.baseRef).toBe("");
    }
    selectCloudWorktree(first);
    first.flow.setMessage("first task");
    vi.mocked(first.context.sessions.createResult).mockResolvedValue(null);
    await first.flow.submit(undefined, true);
    expect(first.flow.pendingPlacement.phase).toBe("creating");
    const original = vi.mocked(first.context.sessions.createResult).mock.calls[0]![0];
    expect(original).toMatchObject({ worktreeName: "first-task" });
    if (base === "implicit") {
      expect(original).not.toHaveProperty("worktreeBaseRef");
    } else {
      expect(original).toHaveProperty("worktreeBaseRef", "main");
    }
    disposeWorktreeDraft(first);
    if (independent) {
      independent.place.setBaseRef("");
      await vi.waitFor(() => expect(prefs.stored()).toMatchObject({ baseRef: "" }));
      disposeWorktreeDraft(independent);
    }
    const retained = structuredClone(prefs.stored());
    const retry = await readyPreferenceDraft(prefs, first.context.gateway);
    const start = vi.fn();
    retry.context.placementStartup.start = start;
    acceptIdlePlacement(retry);
    const warning = vi.spyOn(toast, "showToast").mockReturnValue(false);
    await retry.flow.submit(undefined, true);
    expect(retry.context.sessions.createResult).toHaveBeenCalledExactlyOnceWith(original, {
      reconciliation: "background",
    });
    expect(start).toHaveBeenCalledOnce();
    expect(retry.flow.error).toBeNull();
    if (base !== "cleared") {
      expect(prefs.stored()).toMatchObject({ worktreeName: "" });
      expect(acceptedWarnings(warning)).toEqual([]);
    } else {
      expect(prefs.stored()).toEqual(retained);
      expect(acceptedWarnings(warning)).toHaveLength(1);
    }
  },
);

it("keeps accepted names retired when older model saves commit last", async () => {
  const prefs = identityPreferences(true, async () => ({ models }));
  const { first, next } = await independentDrafts(prefs, false);
  const modelSave = preferenceGate();
  let heldModelSave = false;
  prefs.beforeSave.mockImplementation(async (params) => {
    const entry = params.entries["new-session.v1:main"];
    if (!heldModelSave && hasPreference(entry, "model", "openai/gpt-5.6-sol")) {
      heldModelSave = true;
      expect(entry).toMatchObject({ worktreeName: "first-task" });
      await modelSave.wait();
    }
  });
  const writes = vi.spyOn(next.gateway, "persistPreference");
  await chooseModel(next);
  try {
    await modelSave.started.promise;
    await startAcceptedWorktree(first);
    expect(first.context.sessions.createResult).toHaveBeenCalledOnce();
    expect(first.flow.error).toBeNull();
    expect(prefs.stored()).toMatchObject({ worktreeName: "" });
  } finally {
    modelSave.release.resolve();
    await Promise.all(writes.mock.results.map((result) => result.value));
  }
  expect(next.context.sessions.createResult).not.toHaveBeenCalled();
  expect(prefs.stored()).toMatchObject({ model: "openai/gpt-5.6-sol" });
  expect(decodePreference(prefs.stored()).main?.worktreeName).toBeUndefined();
});
