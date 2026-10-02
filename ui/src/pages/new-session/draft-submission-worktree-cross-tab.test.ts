import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import * as toast from "../../lib/toast.ts";
import { identityPreferences } from "./draft-worktree-preferences.test-support.ts";
import { renderControl } from "./model-control.test-support.ts";
import { decodeIdentityPreferences } from "./preferences.ts";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

it("preserves a newer independent Gateway draft when an accepted clear commits late", async () => {
  const prefs = identityPreferences(true, async () => ({
    models: [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
    ],
  }));
  const first = prefs.make();
  const next = prefs.make();
  expect(first.context.gateway).not.toBe(next.context.gateway);
  expect(first.context.gateway.snapshot.client).not.toBe(next.context.gateway.snapshot.client);
  expect(first.context.gateway.snapshot.selfUser?.id).toBe(
    next.context.gateway.snapshot.selfUser?.id,
  );
  await prefs.ready(first);
  await prefs.ready(next);
  const clearStarted = createDeferred();
  const releaseClear = createDeferred();
  // Delay only A's already prepared replacement before the synthetic server commits it.
  let heldAcceptedClear = false;
  prefs.beforeSave.mockImplementation(async (params) => {
    const entry = params.entries["new-session.v1:main"];
    if (
      !heldAcceptedClear &&
      entry &&
      typeof entry === "object" &&
      "folder" in entry &&
      entry.folder === "/repo" &&
      "worktreeName" in entry &&
      entry.worktreeName === ""
    ) {
      heldAcceptedClear = true;
      clearStarted.resolve();
      await releaseClear.promise;
    }
  });
  vi.mocked(first.context.sessions.createResult).mockResolvedValue({
    key: "agent:main:dashboard:first",
    initialRun: { status: "started", runId: "first-run" },
  });
  first.flow.setMessage("first task");
  const submitting = first.flow.submit(undefined, true);
  let newer: unknown;
  try {
    await clearStarted.promise;
    next.place.applyFolder("/other-repo");
    await vi.waitFor(() => expect(prefs.stored()).toMatchObject({ folder: "/other-repo" }));
    next.place.setWorktreeName("next-task");
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
        folder: "/other-repo",
        worktreeName: "next-task",
        model: "openai/gpt-5.6-sol",
      }),
    );
    newer = structuredClone(prefs.stored());
  } finally {
    releaseClear.resolve();
    await submitting;
  }
  expect(first.context.sessions.createResult).toHaveBeenCalledOnce();
  expect(next.context.sessions.createResult).not.toHaveBeenCalled();
  expect(first.flow.error).toBeNull();
  expect(first.place.worktreeName).toBe("");
  expect(prefs.stored()).toEqual(newer);
});

it.each(["model", "base", "empty base"] as const)(
  "reconciles a concurrent independent draft %s change without losing accepted creation",
  async (change) => {
    const prefs = identityPreferences(true, async () => ({
      models: [
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
      ],
    }));
    const first = prefs.make();
    const next = prefs.make();
    await prefs.ready(first);
    await prefs.ready(next);
    const started = createDeferred();
    const release = createDeferred();
    let held = false;
    prefs.beforeSave.mockImplementation(async (params) => {
      const entry = params.entries["new-session.v1:main"];
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
    vi.mocked(first.context.sessions.createResult).mockResolvedValue({
      key: "agent:main:dashboard:first",
      initialRun: { status: "started", runId: "first-run" },
    });
    const warning = vi.spyOn(toast, "showToast").mockReturnValue(false);
    first.flow.setMessage("first task");
    const submitting = first.flow.submit(undefined, true);
    let newer: unknown;
    try {
      await started.promise;
      if (change === "model") {
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
          expect(prefs.stored()).toMatchObject({ model: "openai/gpt-5.6-sol" }),
        );
      } else {
        const baseRef = change === "base" ? "release" : "";
        next.place.setBaseRef(baseRef);
        await vi.waitFor(() => expect(prefs.stored()).toMatchObject({ baseRef }));
      }
      newer = structuredClone(prefs.stored());
    } finally {
      release.resolve();
      await submitting;
    }
    expect(first.context.sessions.createResult).toHaveBeenCalledOnce();
    expect(next.context.sessions.createResult).not.toHaveBeenCalled();
    expect(first.flow.error).toBeNull();
    expect(
      warning.mock.calls.filter(
        ([notice]) =>
          typeof notice.message === "string" && notice.message.startsWith("Session accepted,"),
      ),
    ).toEqual([]);
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
  },
);

it("warns once after bounded contention without replaying an accepted session", async () => {
  const prefs = identityPreferences();
  const first = prefs.make();
  const next = prefs.make();
  await prefs.ready(first);
  await prefs.ready(next);
  let clears = 0;
  prefs.beforeSave.mockImplementation(async (params) => {
    const entry = params.entries["new-session.v1:main"];
    if (
      entry &&
      typeof entry === "object" &&
      "worktreeName" in entry &&
      entry.worktreeName === ""
    ) {
      clears += 1;
      await prefs.publish(next, { thinkingLevel: `concurrent-${clears}` });
    }
  });
  vi.mocked(first.context.sessions.createResult).mockResolvedValue({
    key: "agent:main:dashboard:first",
    initialRun: { status: "started", runId: "first-run" },
  });
  const warning = vi.spyOn(toast, "showToast").mockReturnValue(false);
  first.flow.setMessage("first task");
  await first.flow.submit(undefined, true);
  expect(first.context.sessions.createResult).toHaveBeenCalledOnce();
  expect(first.flow.error).toBeNull();
  expect(clears).toBe(3);
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
  expect(prefs.stored()).toMatchObject({
    worktreeName: "first-task",
    thinkingLevel: "concurrent-3",
  });
});

it("preserves an explicit base cleared by another draft before acceptance reads preferences", async () => {
  const prefs = identityPreferences();
  const first = prefs.make();
  const next = prefs.make();
  await prefs.ready(first);
  await prefs.ready(next);
  const accepted = createDeferred<{
    key: string;
    initialRun: { status: "started"; runId: string };
  }>();
  vi.mocked(first.context.sessions.createResult).mockReturnValue(accepted.promise);
  first.flow.setMessage("first task");
  const submitting = first.flow.submit(undefined, true);
  await vi.waitFor(() => expect(first.context.sessions.createResult).toHaveBeenCalledOnce());
  next.place.setBaseRef("");
  await vi.waitFor(() => expect(prefs.stored()).toMatchObject({ baseRef: "" }));
  const newer = structuredClone(prefs.stored());
  const { invalidateUserPreferences } = await import("../../app/user-prefs-cache.ts");
  // The other tab's users.prefs.changed event invalidates the old read, not its local selection.
  invalidateUserPreferences(first.context.gateway.snapshot.client!);
  accepted.resolve({
    key: "agent:main:dashboard:first",
    initialRun: { status: "started", runId: "first-run" },
  });
  await submitting;
  expect(first.context.sessions.createResult).toHaveBeenCalledOnce();
  expect(first.flow.error).toBeNull();
  expect(prefs.stored()).toEqual(newer);
});

it.each(["explicit", "implicit", "cleared"] as const)(
  "reconciles a restored creating placement with an %s base without guessing newer intent",
  async (base) => {
    const prefs = identityPreferences();
    let first = prefs.make();
    await prefs.ready(first);
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
    vi.spyOn(first.gateway, "cloudProfiles", "get").mockReturnValue([
      { id: "cloud", providerId: "crabbox", executionModes: ["worker-turn", "remote-exec"] },
    ]);
    vi.spyOn(first.gateway, "cloudProfilesReady", "get").mockReturnValue(true);
    vi.spyOn(first.gateway, "cloudProfilesPending", "get").mockReturnValue(false);
    first.place.selectCloudProfile("cloud");
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
    const retry = prefs.make(first.context.gateway);
    await prefs.ready(retry);
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
  const prefs = identityPreferences(true, async () => ({
    models: [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
    ],
  }));
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
    vi.mocked(first.context.sessions.createResult).mockResolvedValue({
      key: "agent:main:dashboard:first",
      initialRun: { status: "started", runId: "first-run" },
    });
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

it("warns once when an ordinary draft edit exhausts conditional saves without publishing stale preferences", async () => {
  const prefs = identityPreferences();
  const first = prefs.make();
  const next = prefs.make();
  await prefs.ready(first);
  await prefs.ready(next);
  let attempts = 0;
  prefs.beforeSave.mockImplementation(async (params) => {
    const entry = params.entries["new-session.v1:main"];
    if (entry && typeof entry === "object" && "baseRef" in entry && entry.baseRef === "release") {
      attempts += 1;
      await prefs.publish(next, { thinkingLevel: `concurrent-${attempts}` });
    }
  });
  const warning = vi.spyOn(toast, "showToast").mockReturnValue(false);
  const writes = vi.spyOn(first.gateway, "persistPreference");
  first.place.setBaseRef("release");
  await Promise.all(writes.mock.results.map((result) => result.value));
  expect(attempts).toBe(3);
  expect(warning).toHaveBeenCalledExactlyOnceWith({
    message:
      "Saving your new-session choices could not be confirmed. Check them before starting a session.",
  });
  expect(prefs.stored()).toMatchObject({ baseRef: "main", thinkingLevel: "concurrent-3" });
  expect(first.context.sessions.createResult).not.toHaveBeenCalled();
});
