import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import * as toast from "../../lib/toast.ts";
import { identityPreferences } from "./draft-worktree-preferences.test-support.ts";
import {
  acceptedWorktreeSession,
  readyPreferenceDraft,
  selectCloudWorktree,
} from "./draft-worktree-submission.test-support.ts";
import { renderControl } from "./model-control.test-support.ts";
import { decodeIdentityPreferences } from "./preferences.ts";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

const models = ["gpt-5.6-luna", "gpt-5.6-sol"].map((id) => ({ id, name: id, provider: "openai" }));

it.each(["repository", "model", "empty base", "base before read"] as const)(
  "reconciles concurrent independent draft intent: %s",
  async (change) => {
    const prefs = identityPreferences(
      true,
      change === "base before read" ? undefined : async () => ({ models }),
    );
    const first = await readyPreferenceDraft(prefs);
    const next = await readyPreferenceDraft(prefs);
    expect(first.context.gateway).not.toBe(next.context.gateway);
    expect(first.context.gateway.snapshot.client).not.toBe(next.context.gateway.snapshot.client);
    expect(first.context.gateway.snapshot.selfUser?.id).toBe(
      next.context.gateway.snapshot.selfUser?.id,
    );
    const started = createDeferred();
    const release = createDeferred();
    let held = false;
    if (change === "base before read") {
      vi.mocked(first.context.sessions.createResult).mockImplementation(async () => {
        started.resolve();
        await release.promise;
        return acceptedWorktreeSession;
      });
    } else {
      prefs.beforeSave.mockImplementation(async ({ entries }) => {
        const entry = entries["new-session.v1:main"];
        if (
          !held &&
          entry &&
          typeof entry === "object" &&
          "worktreeName" in entry &&
          entry.worktreeName === ""
        ) {
          held = true;
          started.resolve();
          await release.promise;
        }
      });
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
        const control = next.place.modelControl;
        await vi.waitFor(() =>
          expect(
            renderControl(control, next.context).querySelector(
              '[data-chat-model-option="openai/gpt-5.6-sol"]',
            ),
          ).not.toBeNull(),
        );
        renderControl(control, next.context)
          .querySelector<HTMLButtonElement>('[data-chat-model-option="openai/gpt-5.6-sol"]')!
          .click();
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
      expect(
        warning.mock.calls.filter(
          ([notice]) =>
            typeof notice.message === "string" && notice.message.startsWith("Session accepted,"),
        ),
      ).toEqual([]);
    }
    if (change === "model") {
      expect(prefs.stored()).toMatchObject({ worktreeName: "", model: "openai/gpt-5.6-sol" });
      expect(decodeIdentityPreferences({ "new-session.v1:main": prefs.stored() })).toEqual(
        decodeIdentityPreferences({
          "new-session.v1:main": { ...(newer as object), worktreeName: "" },
        }),
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
  "bounds contention for %s without replaying creation",
  async (operation) => {
    const prefs = identityPreferences();
    const first = await readyPreferenceDraft(prefs);
    const next = await readyPreferenceDraft(prefs);
    const accepted = operation === "accepted clear";
    let attempts = 0;
    prefs.beforeSave.mockImplementation(async ({ entries }) => {
      const entry = entries["new-session.v1:main"];
      if (
        entry &&
        typeof entry === "object" &&
        (accepted
          ? "worktreeName" in entry && entry.worktreeName === ""
          : "baseRef" in entry && entry.baseRef === "release")
      ) {
        attempts += 1;
        await prefs.publish(next, { thinkingLevel: `concurrent-${attempts}` });
      }
    });
    const warning = vi.spyOn(toast, "showToast").mockReturnValue(false);
    if (accepted) {
      vi.mocked(first.context.sessions.createResult).mockResolvedValue(acceptedWorktreeSession);
      first.flow.setMessage("first task");
      await first.flow.submit(undefined, true);
      expect(first.context.sessions.createResult).toHaveBeenCalledOnce();
      expect(first.flow.error).toBeNull();
      expect(
        warning.mock.calls.filter(
          ([notice]) =>
            typeof notice.message === "string" && notice.message.startsWith("Session accepted,"),
        ),
      ).toEqual([
        [
          {
            message:
              "Session accepted, but clearing the saved worktree name could not be confirmed. Check Name before starting another worktree.",
          },
        ],
      ]);
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
  "reconciles a restored creating placement with an %s base without guessing newer intent",
  async (base) => {
    const prefs = identityPreferences();
    let first = await readyPreferenceDraft(prefs);
    const independent = base === "cleared" ? prefs.make() : undefined;
    if (independent) {
      await prefs.ready(independent);
    }
    const dispose = (fixture: typeof first) => {
      fixture.gateway.disconnect();
      fixture.place.browser.disconnect();
      fixture.flow.disconnect();
    };
    if (base === "implicit") {
      first.place.setBaseRef("");
      await vi.waitFor(() => expect(prefs.stored()).toMatchObject({ baseRef: "" }));
      dispose(first);
      first = prefs.make();
      await prefs.ready(first);
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
    dispose(first);
    if (independent) {
      independent.place.setBaseRef("");
      await vi.waitFor(() => expect(prefs.stored()).toMatchObject({ baseRef: "" }));
      dispose(independent);
    }
    const retained = structuredClone(prefs.stored());
    const retry = await readyPreferenceDraft(prefs, first.context.gateway);
    const start = vi.fn();
    retry.context.placementStartup.start = start;
    vi.mocked(retry.context.sessions.createResult).mockImplementation(async (params) => ({
      key: params!.key!,
      initialRun: { status: "idle" },
    }));
    const warning = vi.spyOn(toast, "showToast").mockReturnValue(false);
    await retry.flow.submit(undefined, true);
    expect(retry.context.sessions.createResult).toHaveBeenCalledExactlyOnceWith(original, {
      reconciliation: "background",
    });
    expect(start).toHaveBeenCalledOnce();
    expect(retry.flow.error).toBeNull();
    if (base !== "cleared") {
      expect(prefs.stored()).toMatchObject({ worktreeName: "" });
      expect(
        warning.mock.calls.filter(
          ([notice]) =>
            typeof notice.message === "string" && notice.message.startsWith("Session accepted,"),
        ),
      ).toEqual([]);
    } else {
      expect(prefs.stored()).toEqual(retained);
      expect(
        warning.mock.calls.filter(
          ([notice]) =>
            typeof notice.message === "string" && notice.message.startsWith("Session accepted,"),
        ),
      ).toHaveLength(1);
    }
  },
);

it("keeps an accepted name retired when an older independent model save commits last", async () => {
  const prefs = identityPreferences(true, async () => ({ models }));
  const first = prefs.make();
  const next = prefs.make();
  expect(first.context.gateway).not.toBe(next.context.gateway);
  expect(first.context.gateway.snapshot.client).not.toBe(next.context.gateway.snapshot.client);
  expect(first.context.gateway.snapshot.selfUser?.id).toBe(
    next.context.gateway.snapshot.selfUser?.id,
  );
  await prefs.ready(first);
  await prefs.ready(next);
  const modelSaveStarted = createDeferred();
  const releaseModelSave = createDeferred();
  let heldModelSave = false;
  prefs.beforeSave.mockImplementation(async (params) => {
    const entry = params.entries["new-session.v1:main"];
    if (
      !heldModelSave &&
      entry &&
      typeof entry === "object" &&
      "model" in entry &&
      entry.model === "openai/gpt-5.6-sol"
    ) {
      heldModelSave = true;
      expect(entry).toMatchObject({ worktreeName: "first-task" });
      modelSaveStarted.resolve();
      await releaseModelSave.promise;
    }
  });
  const writes = vi.spyOn(next.gateway, "persistPreference");
  const control = next.place.modelControl;
  await vi.waitFor(() =>
    expect(
      renderControl(control, next.context).querySelector(
        '[data-chat-model-option="openai/gpt-5.6-sol"]',
      ),
    ).not.toBeNull(),
  );
  renderControl(control, next.context)
    .querySelector<HTMLButtonElement>('[data-chat-model-option="openai/gpt-5.6-sol"]')!
    .click();
  try {
    await modelSaveStarted.promise;
    vi.mocked(first.context.sessions.createResult).mockResolvedValue(acceptedWorktreeSession);
    first.flow.setMessage("first task");
    await first.flow.submit(undefined, true);
    expect(first.context.sessions.createResult).toHaveBeenCalledOnce();
    expect(first.flow.error).toBeNull();
    expect(prefs.stored()).toMatchObject({ worktreeName: "" });
  } finally {
    releaseModelSave.resolve();
    await Promise.all(writes.mock.results.map((result) => result.value));
  }
  expect(next.context.sessions.createResult).not.toHaveBeenCalled();
  expect(prefs.stored()).toMatchObject({ model: "openai/gpt-5.6-sol" });
  expect(
    decodeIdentityPreferences({ "new-session.v1:main": prefs.stored() }).main?.worktreeName,
  ).toBeUndefined();
});
