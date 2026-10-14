import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import * as toast from "../../lib/toast.ts";
import { CHAT_ROUTE_READY_EVENT } from "../chat/chat-history-events.ts";
import { identityPreferences } from "./draft-worktree-preferences.test-support.ts";
import {
  acceptedWorktreeSession,
  disposeWorktreeDraft,
  readyPreferenceDraft,
  selectCloudWorktree,
  submitPendingWorktree,
} from "./draft-worktree-submission.test-support.ts";
import { renderControl } from "./model-control.test-support.ts";
import { loadNewSessionPreference } from "./preferences.ts";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

it.each([
  { identified: false, fastMode: true, speedOption: "on" },
  { identified: true, fastMode: "ultrafast", speedOption: "ultrafast" },
] as const)(
  "consumes the accepted name while preserving newer model controls, identity=$identified, speed=$speedOption",
  async ({ identified, fastMode, speedOption }) => {
    const prefs = identityPreferences(identified, async () => ({
      models: [
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          reasoning: true,
          available: true,
          serviceTiers: ["ultrafast"],
          thinkingLevels: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
      ],
    }));
    const first = await readyPreferenceDraft(prefs);
    const { admitted, submitting } = await submitPendingWorktree(first);
    const next = await readyPreferenceDraft(prefs, first.context.gateway);
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
    const thinking = renderControl(control, next.context).querySelector<HTMLInputElement>(
      '[data-chat-thinking-slider="true"]',
    )!;
    thinking.value = "1";
    thinking.dispatchEvent(new Event("change", { bubbles: true }));
    renderControl(control, next.context)
      .querySelector<HTMLButtonElement>(`[data-chat-speed-option="${speedOption}"]`)!
      .click();
    const selected = { model: "openai/gpt-5.6-sol", thinkingLevel: "high", fastMode };
    await vi.waitFor(() => expect(prefs.stored()).toMatchObject(selected));
    admitted.resolve(acceptedWorktreeSession);
    await submitting;
    expect(next.place.worktreeName).toBe("");
    expect(prefs.stored()).toMatchObject(selected);
    expect(loadNewSessionPreference("ws://gateway.example", "main")?.worktreeName).toBeUndefined();
    expect(control.selected).toBe(selected.model);
    expect(control.thinkingLevel).toBe(selected.thinkingLevel);
    expect(control.fastMode).toBe(selected.fastMode);
  },
);

it.each(["composer retirement", "preference clear"] as const)(
  "placement cannot publish after disposal during %s",
  async (phase) => {
    const prefs = identityPreferences();
    const first = await readyPreferenceDraft(prefs);
    selectCloudWorktree(first);
    const start = vi.fn(() => {
      if (phase === "composer retirement") {
        queueMicrotask(() => {
          first.flow.invalidate();
          disposeWorktreeDraft(first);
        });
      }
    });
    first.context.placementStartup.start = start;
    vi.mocked(first.context.sessions.createResult).mockImplementation(async (params) => ({
      key: params!.key!,
      initialRun: { status: "idle" },
    }));
    const clearStarted = createDeferred();
    const clear = createDeferred();
    if (phase === "preference clear") {
      prefs.beforeSave.mockImplementation(async ({ entries }) => {
        const entry = entries["new-session.v1:main"];
        if (
          entry &&
          typeof entry === "object" &&
          "worktreeName" in entry &&
          entry.worktreeName === ""
        ) {
          clearStarted.resolve();
          await clear.promise;
        }
      });
    }
    first.flow.setMessage("first task");
    expect(first.flow.submitDisabledReason()).toBeUndefined();
    const submitting = first.flow.submit(undefined, phase === "composer retirement");
    if (phase === "preference clear") {
      await clearStarted.promise;
      expect(start).toHaveBeenCalledOnce();
      first.flow.invalidate();
      first.gateway.disconnect();
      clear.resolve();
    }
    await submitting;
    expect(first.context.sessions.createResult).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(first.context.navigateAndWait).not.toHaveBeenCalled();
    expect(first.request.mock.calls.some(([method]) => method === "agent.wait")).toBe(false);
    if (phase === "composer retirement") {
      await readyPreferenceDraft(prefs, first.context.gateway);
      expect(
        loadNewSessionPreference("ws://gateway.example", "main")?.worktreeName,
      ).toBeUndefined();
      expect(prefs.stored()).toMatchObject({ worktreeName: "" });
    }
  },
);

it("opens an accepted worktree while its saved name cleanup is pending", async () => {
  const prefs = identityPreferences();
  const first = await readyPreferenceDraft(prefs);
  const admission = createDeferred<typeof acceptedWorktreeSession>();
  const clearing = createDeferred();
  const clearStarted = createDeferred();
  const navigated = createDeferred();
  prefs.beforeSave.mockImplementation(async () => {
    clearStarted.resolve();
    await clearing.promise;
  });
  vi.mocked(first.context.sessions.createResult).mockReturnValue(admission.promise);
  vi.mocked(first.context.navigateAndWait).mockImplementation(async () => {
    disposeWorktreeDraft(first);
    navigated.resolve();
    queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
  });
  first.flow.setMessage("first task");
  vi.useFakeTimers();
  try {
    const submitting = first.flow.submit();
    let settled = false;
    void submitting.then(() => {
      settled = true;
    });
    // Worktree preparation finishes after several seconds, then the run is accepted.
    await vi.advanceTimersByTimeAsync(5_000);
    admission.resolve(acceptedWorktreeSession);
    await clearStarted.promise;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(first.context.navigateAndWait).toHaveBeenCalledOnce();
      await navigated.promise;
      expect(first.context.gateway.snapshot.sessionKey).toBe(acceptedWorktreeSession.key);
      expect(
        first.context.chatSubmissions.readInitial(
          acceptedWorktreeSession.key,
          first.context.gateway.snapshot.client!,
        )?.pendingRunId,
      ).toBe("first-run");
      expect(settled).toBe(false);
    } finally {
      clearing.resolve();
      await submitting;
    }
    vi.useRealTimers();
    const next = await readyPreferenceDraft(prefs, first.context.gateway);
    expect(next.place.worktreeName).toBe("");
    expect(loadNewSessionPreference("ws://gateway.example", "main")?.worktreeName).toBeUndefined();
    expect(first.context.sessions.createResult).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  { identified: false, change: "renamed" },
  { identified: true, change: "renamed" },
  { identified: false, change: "reconnected" },
  { identified: true, change: "reconnected" },
  { identified: true, change: "hello" },
  { identified: true, change: "client" },
  { identified: true, change: "hydrated name" },
  { identified: true, change: "hydrated folder" },
  { identified: true, change: "hydrated base" },
  { identified: true, change: "agent" },
] as const)(
  "late acceptance respects $change intent (identity=$identified)",
  async ({ identified, change }) => {
    const prefs = identityPreferences(identified);
    const first = await readyPreferenceDraft(prefs);
    const { admitted, submitting } = await submitPendingWorktree(first);
    let next = first;
    let retained: unknown;
    const patch =
      change === "hydrated name"
        ? { worktreeName: "hydrated-task" }
        : change === "hydrated folder"
          ? { folder: "/other-repo" }
          : { baseRef: "next-base" };
    const hydrated = change.startsWith("hydrated");
    if (change === "renamed" || change === "reconnected") {
      if (change === "reconnected") {
        first.flow.invalidate("gateway-changed");
        first.place.invalidateGatewayDiscovery(true);
      }
      disposeWorktreeDraft(first);
      next = await readyPreferenceDraft(prefs, first.context.gateway);
      if (change === "renamed") {
        next.place.setWorktreeName("next-task");
        await vi.waitFor(() => expect(prefs.stored()).toMatchObject({ worktreeName: "next-task" }));
      } else {
        expect(next.place.worktreeName).toBe("first-task");
      }
    } else if (change === "hello" || change === "client") {
      Object.assign(
        change === "hello"
          ? first.context.gateway.snapshot.hello!.auth!
          : first.context.gateway.snapshot.client!,
        { recoveryScope: "principal-b" },
      );
    } else if (hydrated) {
      await prefs.publish(first, patch);
      next = await readyPreferenceDraft(prefs, first.context.gateway);
      retained = structuredClone(prefs.stored());
    } else {
      first.flow.invalidate();
      first.flow.resetDraft();
      first.place.selectAgentId("work");
      expect(first.place.worktreeName).toBe("work-task");
      retained = structuredClone(prefs.stored("work"));
    }
    admitted.resolve(acceptedWorktreeSession);
    await submitting;
    if (change === "renamed") {
      expect(next.place.worktreeName).toBe("next-task");
      expect(prefs.stored()).toMatchObject({ worktreeName: "next-task" });
    } else if (change === "reconnected") {
      expect(next.place.worktreeName).toBe("");
      expect(first.context.navigateAndWait).not.toHaveBeenCalled();
    } else if (change === "hello" || change === "client") {
      expect(prefs.stored()).toMatchObject({ worktreeName: "first-task" });
    } else if (hydrated) {
      expect(prefs.stored()).toEqual(retained);
      expect(next.place.worktreeName).toBe(patch.worktreeName ?? "first-task");
    } else {
      expect(prefs.stored()).toMatchObject({ worktreeName: "" });
      expect(prefs.stored("work")).toEqual(retained);
      expect(first.place.agentId).toBe("work");
      expect(first.place.worktreeName).toBe("work-task");
      expect(first.context.navigateAndWait).not.toHaveBeenCalled();
    }
  },
);

it.each(["name", "base"])(
  "orders an accepted clear before a newer controller's %s edit",
  async (edit) => {
    const prefs = identityPreferences();
    const first = await readyPreferenceDraft(prefs);
    const next = await readyPreferenceDraft(prefs, first.context.gateway);
    const observer = await readyPreferenceDraft(prefs, first.context.gateway);
    const clearStarted = createDeferred();
    const clear = createDeferred();
    prefs.beforeSave.mockImplementation(async (params) => {
      const entry = params.entries["new-session.v1:main"];
      if (
        entry &&
        typeof entry === "object" &&
        "worktreeName" in entry &&
        entry.worktreeName === ""
      ) {
        clearStarted.resolve();
        await clear.promise;
      }
    });
    vi.mocked(first.context.sessions.createResult).mockResolvedValue(acceptedWorktreeSession);
    first.flow.setMessage("first task");
    const submitting = first.flow.submit(undefined, true);
    await clearStarted.promise;
    const writes = vi.spyOn(next.gateway, "persistPreference");
    if (edit === "name") {
      next.place.setWorktreeName("next-task");
    } else {
      next.place.setBaseRef("next-base");
    }
    // Give queued preference continuations a turn while the previous write remains unacknowledged.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    const concurrentWrites = prefs.beforeSave.mock.calls.length;
    clear.resolve();
    await Promise.all([submitting, writes.mock.results.at(-1)?.value]);
    if (edit === "name") {
      expect(prefs.stored()).toMatchObject({ worktreeName: "next-task", baseRef: "main" });
    } else {
      expect(prefs.stored()).toMatchObject({ baseRef: "next-base" });
      expect(prefs.stored()).not.toHaveProperty("worktreeName");
    }
    expect(observer.place.worktreeName).toBe("");
    if (edit === "base") {
      expect(next.place.worktreeName).toBe("");
      expect(next.place.baseRef).toBe("next-base");
    } else {
      expect(next.place.worktreeName).toBe("next-task");
    }
    expect(concurrentWrites).toBe(1);
  },
);

it("does not drain queued Gateway edits into a newer disconnected browser choice", async () => {
  const prefs = identityPreferences();
  const first = await readyPreferenceDraft(prefs);
  const started = createDeferred();
  const release = createDeferred();
  prefs.beforeSave.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
  });
  const writes = vi.spyOn(first.gateway, "persistPreference");
  first.place.setBaseRef("release");
  await started.promise;
  try {
    first.place.setWorktreeName("queued-task");
    first.context.gateway.snapshot.phase = "reconnecting";
    first.gateway.synchronize(first.context.gateway);
    first.place.setWorktreeName("new-local-task");
    expect(loadNewSessionPreference("ws://gateway.example", "main")).toMatchObject({
      worktreeName: "new-local-task",
    });
  } finally {
    release.resolve();
    await Promise.all(writes.mock.results.map((result) => result.value));
  }
  expect(loadNewSessionPreference("ws://gateway.example", "main")).toMatchObject({
    worktreeName: "new-local-task",
  });
});

it.each([false, true])(
  "publishes only a committed disposed-owner edit and drops its queued successor, conflict=%s",
  async (conflict) => {
    const prefs = identityPreferences();
    const first = await readyPreferenceDraft(prefs);
    const observer = await readyPreferenceDraft(prefs, first.context.gateway);
    const started = createDeferred();
    const release = createDeferred();
    prefs.beforeSave.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
    });
    const saving = first.gateway.persistPreference("main", "/repo", { baseRef: "release" });
    await started.promise;
    const queued = first.gateway.persistPreference("main", "/repo", {
      worktreeName: "queued-task",
    });
    try {
      first.gateway.disconnect();
      if (conflict) {
        await prefs.publish(observer, { baseRef: "external-base" });
      }
    } finally {
      release.resolve();
      await Promise.all([saving, queued]);
    }
    const baseRef = conflict ? "external-base" : "release";
    expect(prefs.stored()).toMatchObject({ baseRef, worktreeName: "first-task" });
    expect(prefs.beforeSave).toHaveBeenCalledTimes(conflict ? 2 : 1);
    expect(observer.gateway.readPreference("main")?.baseRef).toBe(conflict ? "main" : "release");
    // Confirmed defaults refresh the projection, not another open draft’s active fields.
    expect(observer.place.baseRef).toBe("main");
    const next = await readyPreferenceDraft(prefs, first.context.gateway);
    expect(next.place.baseRef).toBe(baseRef);
    expect(next.place.worktreeName).toBe("first-task");
  },
);

it("does not let a replacement draft's pending preference load restore a consumed name", async () => {
  const prefs = identityPreferences();
  const first = await readyPreferenceDraft(prefs);
  const clear = createDeferred();
  const clearStarted = createDeferred();
  prefs.beforeSave.mockImplementation(async () => {
    clearStarted.resolve();
    await clear.promise;
  });
  vi.mocked(first.context.sessions.createResult).mockResolvedValue(acceptedWorktreeSession);
  first.flow.setMessage("first task");
  const submitting = first.flow.submit(undefined, true);
  await clearStarted.promise;
  disposeWorktreeDraft(first);
  const read = createDeferred();
  const readStarted = createDeferred();
  prefs.beforeRead.mockImplementationOnce(async () => {
    readStarted.resolve();
    await read.promise;
  });
  const next = prefs.make(first.context.gateway);
  await readStarted.promise;
  clear.resolve();
  await submitting;
  read.resolve();
  await prefs.ready(next);
  expect(next.place.worktreeName).toBe("");
  next.flow.setMessage("next task");
  await next.flow.submit(undefined, true);
  expect(next.context.sessions.createResult).toHaveBeenCalledWith(
    expect.not.objectContaining({ worktreeName: "first-task" }),
    { reconciliation: "background" },
  );
});

it.each(["read", "save", "transport", "browser"] as const)(
  "warns without reversing accepted creation when preference %s fails",
  async (failure) => {
    const prefs = identityPreferences(failure !== "browser");
    const fixture = await readyPreferenceDraft(prefs);
    const warning = vi.spyOn(toast, "showToast").mockReturnValue(false);
    vi.mocked(fixture.context.navigateAndWait).mockImplementation(async () => {
      queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
    });
    const write = localStorage.setItem.bind(localStorage);
    const rejectedWrite =
      failure === "browser"
        ? vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
            if (key.includes("new-session")) {
              throw new Error("Synthetic browser quota exceeded");
            }
            return write(key, value);
          })
        : undefined;
    if (failure !== "browser") {
      const original = fixture.request.getMockImplementation()!;
      fixture.request.mockImplementation(async (method, params) => {
        if (method === (failure === "read" ? "users.prefs.get" : "users.prefs.set")) {
          if (failure === "transport") {
            throw new Error("Synthetic preference write unavailable");
          }
          return { status: "no_durable_identity" };
        }
        return original(method, params);
      });
      const { invalidateUserPreferences } = await import("../../app/user-prefs-cache.ts");
      invalidateUserPreferences(fixture.context.gateway.snapshot.client!);
    }
    vi.mocked(fixture.context.sessions.createResult).mockResolvedValue(acceptedWorktreeSession);
    fixture.flow.setMessage("first task");
    await fixture.flow.submit();
    expect(fixture.context.sessions.createResult).toHaveBeenCalledOnce();
    expect(fixture.context.navigateAndWait).toHaveBeenCalledOnce();
    expect(fixture.flow.error).toBeNull();
    expect(warning).toHaveBeenCalledExactlyOnceWith({
      message:
        "Session accepted, but clearing the saved worktree name could not be confirmed. Check Name before starting another worktree.",
    });
    expect(prefs.stored()).toMatchObject({ worktreeName: "first-task" });
    if (rejectedWrite) {
      expect(rejectedWrite).toHaveBeenCalledWith(
        expect.stringContaining("new-session.preferences"),
        expect.any(String),
      );
    } else {
      expect(loadNewSessionPreference("ws://gateway.example", "main")).toMatchObject({
        worktreeName: "first-task",
      });
    }
  },
);

it("retires the restored placement's agent preference even when the picker hydrates the default agent", async () => {
  const prefs = identityPreferences();
  const first = await readyPreferenceDraft(prefs);
  first.place.selectAgentId("work");
  await vi.waitFor(() => expect(first.place.worktreeName).toBe("work-task"));
  selectCloudWorktree(first);
  first.flow.setMessage("work task");
  vi.mocked(first.context.sessions.createResult).mockResolvedValue(null);
  await first.flow.submit(undefined, true);
  expect(first.flow.pendingPlacement.phase).toBe("creating");
  const original = vi.mocked(first.context.sessions.createResult).mock.calls[0]![0];
  expect(original).toMatchObject({ agentId: "work", worktreeName: "work-task" });
  disposeWorktreeDraft(first);
  const retry = await readyPreferenceDraft(prefs, first.context.gateway);
  expect(retry.flow.pendingPlacement.agentId).toBe("work");
  expect(retry.place.agentId).toBe("main");
  const mainPreference = structuredClone(prefs.stored());
  const start = vi.fn();
  retry.context.placementStartup.start = start;
  vi.mocked(retry.context.sessions.createResult).mockImplementation(async (params) => ({
    key: params!.key!,
    initialRun: { status: "idle" },
  }));
  await retry.flow.submit(undefined, true);
  expect(retry.context.sessions.createResult).toHaveBeenCalledExactlyOnceWith(original, {
    reconciliation: "background",
  });
  expect(start).toHaveBeenCalledOnce();
  expect(prefs.stored("work")).toMatchObject({ worktreeName: "" });
  expect(prefs.stored()).toEqual(mainPreference);
});
