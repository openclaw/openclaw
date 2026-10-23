import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import * as toast from "../../lib/toast.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { CHAT_ROUTE_READY_EVENT } from "../chat/chat-history-events.ts";
import {
  createDraftFixture,
  backgroundCreateOptions,
  readyChatRoute,
} from "./draft-submission-flow.test-support.ts";
import {
  browserPreference,
  preferenceGate,
  expectWorktreeName,
  holdPreferenceClear,
  acceptIdlePlacement,
  resetWorktreeMocks,
  startAcceptedWorktree,
  acceptedNameWarning,
  chooseModel,
} from "./draft-worktree-checks.test-support.ts";
import { identityPreferences } from "./draft-worktree-preferences.test-support.ts";
import {
  acceptedWorktreeSession,
  disposeWorktreeDraft,
  readyPreferenceDraft,
  selectCloudWorktree,
  submitPendingWorktree,
} from "./draft-worktree-submission.test-support.ts";
import { testModel } from "./model-control-view-queries.test-support.ts";
import { renderControl } from "./model-control.test-support.ts";
import { decodeIdentityPreferences } from "./preferences.ts";

afterEach(resetWorktreeMocks);

async function preferenceDraft(...options: Parameters<typeof identityPreferences>) {
  const prefs = identityPreferences(...options);
  return { prefs, first: await readyPreferenceDraft(prefs) };
}

it.each([
  { identified: false, fastMode: true, speedOption: "on" },
  { identified: true, fastMode: "ultrafast", speedOption: "ultrafast" },
] as const)(
  "preserves newer model controls, identity=$identified, speed=$speedOption",
  async ({ identified, fastMode, speedOption }) => {
    const { prefs, first } = await preferenceDraft(identified, async () => ({
      models: [
        testModel("openai", "gpt-5.6-luna"),
        testModel("openai", "gpt-5.6-sol", {
          reasoning: true,
          available: true,
          serviceTiers: ["ultrafast"],
          thinkingLevels: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        }),
      ],
    }));
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
    const rendered = renderControl(control, next.context);
    const initialEffort = await waitForSolid(() => {
      const picker = rendered.querySelector<HTMLDetailsElement>(
        ".chat-controls__effort-picker[data-chat-native-picker]",
      );
      expect(picker).not.toBeNull();
      return picker!;
    });
    if (!initialEffort.open) {
      initialEffort.querySelector<HTMLElement>("summary")!.click();
    }
    const thinking = await waitForSolid(() => {
      const input = rendered.querySelector<HTMLInputElement>('[data-chat-thinking-slider="true"]');
      expect(input).not.toBeNull();
      return input!;
    });
    thinking.value = "1";
    thinking.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForSolid(() =>
      expect(rendered.querySelector(".chat-controls__effort-trigger")?.textContent).toContain(
        "High",
      ),
    );
    // A model-control refresh can replace the open menu; use its current visible trigger.
    const effort = rendered.querySelector<HTMLDetailsElement>(".chat-controls__effort-picker")!;
    if (effort.open) {
      effort.querySelector<HTMLElement>("summary")!.click();
    }
    await waitForSolid(() =>
      expect(rendered.querySelector(".chat-controls__effort-menu")).toBeNull(),
    );
    effort.querySelector<HTMLElement>("summary")!.click();
    const speed = await waitForSolid(() => {
      const button = rendered.querySelector<HTMLButtonElement>(
        `[data-chat-speed-option="${speedOption}"]`,
      );
      expect(button).not.toBeNull();
      return button!;
    });
    speed.click();
    const selected = { model: "openai/gpt-5.6-sol", thinkingLevel: "high", fastMode };
    await vi.waitFor(() => expect(prefs.stored()).toMatchObject(selected));
    admitted.resolve(acceptedWorktreeSession);
    await submitting;
    expectWorktreeName(next.place);
    expect(prefs.stored()).toMatchObject(selected);
    expect(control).toMatchObject({ selected: selected.model, thinkingLevel: "high", fastMode });
  },
);

it.each(["composer retirement", "preference clear"] as const)(
  "prevents placement publication after %s disposal",
  async (phase) => {
    const { prefs, first } = await preferenceDraft();
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
    acceptIdlePlacement(first);
    const clear = phase === "preference clear" ? holdPreferenceClear(prefs) : undefined;
    first.flow.setMessage("first task");
    expect(first.flow.submitDisabledReason()).toBeUndefined();
    const submitting = first.flow.submit(undefined, phase === "composer retirement");
    if (phase === "preference clear") {
      await clear!.started.promise;
      expect(start).toHaveBeenCalledOnce();
      first.flow.invalidate();
      first.gateway.disconnect();
      clear!.release.resolve();
    }
    await submitting;
    expect(first.context.sessions.createResult).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(first.context.navigateAndWait).not.toHaveBeenCalled();
    expect(first.request.mock.calls.some(([method]) => method === "agent.wait")).toBe(false);
    if (phase === "composer retirement") {
      await readyPreferenceDraft(prefs, first.context.gateway);
      expect(browserPreference()?.worktreeName).toBeUndefined();
      expect(prefs.stored()).toMatchObject({ worktreeName: "" });
    }
  },
);

it("opens an accepted worktree while its saved name cleanup is pending", async () => {
  const { prefs, first } = await preferenceDraft();
  const { context, flow } = first;
  const admission = createDeferred<typeof acceptedWorktreeSession>();
  const { started: clearStarted, release: clearing, wait } = preferenceGate();
  const navigated = createDeferred();
  prefs.beforeSave.mockImplementation(wait);
  vi.mocked(context.sessions.createResult).mockReturnValue(admission.promise);
  vi.mocked(context.navigateAndWait).mockImplementation(async () => {
    disposeWorktreeDraft(first);
    navigated.resolve();
    queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
  });
  flow.setMessage("first task");
  vi.useFakeTimers();
  try {
    const submitting = flow.submit();
    let settled = false;
    void submitting.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    admission.resolve(acceptedWorktreeSession);
    await clearStarted.promise;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(context.navigateAndWait).toHaveBeenCalledOnce();
      await navigated.promise;
      const { key } = acceptedWorktreeSession;
      expect(context.gateway.snapshot.sessionKey).toBe(key);
      expect(
        context.chatSubmissions.readInitial(key, context.gateway.snapshot.client!),
      ).toMatchObject({ pendingRunId: "first-run" });
      expect(settled).toBe(false);
    } finally {
      clearing.resolve();
      await submitting;
    }
    vi.useRealTimers();
    const next = await readyPreferenceDraft(prefs, context.gateway);
    expectWorktreeName(next.place);
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
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
    const { prefs, first } = await preferenceDraft(identified);
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
      expect(first.place).toMatchObject({ agentId: "work", worktreeName: "work-task" });
      expect(first.context.navigateAndWait).not.toHaveBeenCalled();
    }
  },
);

it.each(["name", "base"])("orders accepted clear before newer %s edits", async (edit) => {
  const { prefs, first } = await preferenceDraft();
  const next = await readyPreferenceDraft(prefs, first.context.gateway);
  const observer = await readyPreferenceDraft(prefs, first.context.gateway);
  const clear = holdPreferenceClear(prefs);
  const submitting = startAcceptedWorktree(first);
  await clear.started.promise;
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
  clear.release.resolve();
  await Promise.all([submitting, writes.mock.results.at(-1)?.value]);
  if (edit === "name") {
    expect(prefs.stored()).toMatchObject({ worktreeName: "next-task", baseRef: "main" });
    expect(next.place.worktreeName).toBe("next-task");
  } else {
    expect(prefs.stored()).toMatchObject({ baseRef: "next-base" });
    expect(prefs.stored()).not.toHaveProperty("worktreeName");
    expect(next.place).toMatchObject({ worktreeName: "", baseRef: "next-base" });
  }
  expect(observer.place.worktreeName).toBe("");
  expect(concurrentWrites).toBe(1);
});

it("does not drain queued Gateway edits into a newer disconnected browser choice", async () => {
  const { prefs, first } = await preferenceDraft();
  const { started, release, wait } = preferenceGate();
  prefs.beforeSave.mockImplementationOnce(wait);
  const writes = vi.spyOn(first.gateway, "persistPreference");
  first.place.setBaseRef("release");
  await started.promise;
  try {
    first.place.setWorktreeName("queued-task");
    first.context.gateway.snapshot.phase = "reconnecting";
    first.gateway.synchronize(first.context.gateway);
    first.place.setWorktreeName("new-local-task");
    expect(browserPreference()).toMatchObject({ worktreeName: "new-local-task" });
  } finally {
    release.resolve();
    await Promise.all(writes.mock.results.map((result) => result.value));
  }
  expect(browserPreference()).toMatchObject({ worktreeName: "new-local-task" });
});

it.each([false, true])(
  "publishes only committed disposed-owner edits, conflict=%s",
  async (conflict) => {
    const { prefs, first } = await preferenceDraft();
    const observer = await readyPreferenceDraft(prefs, first.context.gateway);
    const { started, release, wait } = preferenceGate();
    prefs.beforeSave.mockImplementationOnce(wait);
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
    expect(next.place).toMatchObject({ baseRef, worktreeName: "first-task" });
  },
);

it("does not let a replacement draft's pending preference load restore a consumed name", async () => {
  const { prefs, first } = await preferenceDraft();
  const { started: clearStarted, release: clear, wait } = preferenceGate();
  prefs.beforeSave.mockImplementation(wait);
  const submitting = startAcceptedWorktree(first);
  await clearStarted.promise;
  disposeWorktreeDraft(first);
  const { started: readStarted, release: read, wait: waitRead } = preferenceGate();
  prefs.beforeRead.mockImplementationOnce(waitRead);
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
    backgroundCreateOptions,
  );
});

it.each(["read", "save", "transport", "browser"] as const)(
  "warns after acceptance when preference %s fails",
  async (failure) => {
    const { prefs, first: fixture } = await preferenceDraft(failure !== "browser");
    const warning = vi.spyOn(toast, "showToast").mockReturnValue(false);
    vi.mocked(fixture.context.navigateAndWait).mockImplementation(readyChatRoute);
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
    await startAcceptedWorktree(fixture, false);
    expect(fixture.context.sessions.createResult).toHaveBeenCalledOnce();
    expect(fixture.context.navigateAndWait).toHaveBeenCalledOnce();
    expect(fixture.flow.error).toBeNull();
    expect(warning).toHaveBeenCalledExactlyOnceWith(acceptedNameWarning);
    expect(prefs.stored()).toMatchObject({ worktreeName: "first-task" });
    if (rejectedWrite) {
      expect(rejectedWrite).toHaveBeenCalledWith(
        expect.stringContaining("new-session.preferences"),
        expect.any(String),
      );
    } else {
      expect(browserPreference()).toMatchObject({ worktreeName: "first-task" });
    }
  },
);

it("retires the restored agent's name despite default-agent hydration", async () => {
  const { prefs, first } = await preferenceDraft();
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
  acceptIdlePlacement(retry);
  await retry.flow.submit(undefined, true);
  expect(retry.context.sessions.createResult).toHaveBeenCalledExactlyOnceWith(
    original,
    backgroundCreateOptions,
  );
  expect(start).toHaveBeenCalledOnce();
  expect(prefs.stored("work")).toMatchObject({ worktreeName: "" });
  expect(prefs.stored()).toEqual(mainPreference);
});

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
    expect(retry.context.sessions.createResult).toHaveBeenCalledExactlyOnceWith(
      original,
      backgroundCreateOptions,
    );
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

async function namedWorktreeFixture(explicitBase = true, restore = false) {
  const fixture = createDraftFixture({
    scopes: ["operator.admin", "operator.read", "operator.write"],
    methods: ["sessions.create", "sessions.dispatch"],
    agents: [
      {
        id: "main",
        workspace: "/repo",
        workspaceGit: true,
        model: { primary: "openai/gpt-5.6-luna" },
      },
    ],
    request: async (method) =>
      method === "worktrees.branches"
        ? { repositoryStatus: "git", branches: ["main"], defaultBranch: "main" }
        : { status: "ok", endedAt: 1 },
  });
  await vi.waitFor(() => expect(fixture.place.repository.kind).toBe("git"));
  if (!restore) {
    fixture.place.selectWorktree(true);
    if (explicitBase) {
      fixture.place.setBaseRef("main");
    }
    fixture.place.setWorktreeName(explicitBase ? "first-task" : "  first-task  ");
  }
  fixture.flow.setMessage("first task");
  vi.mocked(fixture.context.navigateAndWait).mockImplementation(readyChatRoute);
  return { ...fixture, create: vi.mocked(fixture.context.sessions.createResult) };
}

it.each([true, false])("consumes accepted names, explicit base=%s", async (explicitBase) => {
  const { create, flow, place } = await namedWorktreeFixture(explicitBase);
  if (!explicitBase) {
    expect(browserPreference()?.baseRef).toBeUndefined();
  }
  create.mockResolvedValue(acceptedWorktreeSession);
  expect(flow.submitDisabledReason()).toBeUndefined();
  await flow.submit(undefined, !explicitBase);
  expectWorktreeName(place);
  if (explicitBase) {
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree: true,
        worktreeName: "first-task",
        worktreeBaseRef: "main",
      }),
      backgroundCreateOptions,
    );
    expect(place).toMatchObject({ worktree: true, baseRef: "main" });
    expect(browserPreference()).toMatchObject({ worktree: true, baseRef: "main" });
    const next = await namedWorktreeFixture(true, true);
    next.flow.setMessage("next task");
    next.create.mockResolvedValue(acceptedWorktreeSession);
    await next.flow.submit(undefined, true);
    expect(next.create).toHaveBeenCalledOnce();
    expect(next.create.mock.calls[0]![0]).not.toHaveProperty("worktreeName");
  }
});
it.each(["null", "throw", "rejected"])("retains the name after %s admission", async (outcome) => {
  const { create, flow, place } = await namedWorktreeFixture();
  if (outcome === "throw") {
    create.mockRejectedValue(new Error("admission failed"));
  } else {
    create.mockResolvedValue(
      outcome === "null"
        ? null
        : {
            key: "agent:main:dashboard:first",
            initialRun: { status: "rejected", error: "worktree unavailable" },
          },
    );
  }
  await flow.submit(undefined, true);
  expect(create).toHaveBeenCalledOnce();
  expectWorktreeName(place, "first-task");
});

it.each(["reconnect", "same name again", "new repository", "new principal"])(
  "late acceptance respects %s",
  async (change) => {
    const fixture = await namedWorktreeFixture();
    const { context, flow, place, gateway } = fixture;
    const { admitted, submitting } = await submitPendingWorktree(fixture);
    flow.invalidate(change === "reconnect" ? "gateway-changed" : null);
    if (change !== "reconnect" && change !== "new principal") {
      flow.resetDraft();
    }
    if (change === "same name again") {
      place.setWorktreeName("next-task");
      place.setWorktreeName("first-task");
    }
    if (change === "new repository") {
      place.applyFolder("/other-repo");
      place.selectWorktree(true);
      place.setWorktreeName("first-task");
    }
    if (change === "new principal") {
      Object.assign(context.gateway.snapshot.client!, { recoveryScope: "principal-b" });
      Object.assign(context.gateway.snapshot.hello!.auth!, { recoveryScope: "principal-b" });
      gateway.synchronize(context.gateway);
    }
    admitted.resolve(acceptedWorktreeSession);
    await submitting;
    expect(place.worktreeName).toBe(change === "reconnect" ? "" : "first-task");
    expect(context.navigateAndWait).not.toHaveBeenCalled();
  },
);

it.each([false, true])("retries frozen placement, restored=%s", async (restored) => {
  const first = await namedWorktreeFixture();
  selectCloudWorktree(first);
  const start = vi.fn();
  first.context.placementStartup.start = start;
  first.create.mockResolvedValue(null);
  expect(first.flow.submitDisabledReason()).toBeUndefined();
  await first.flow.submit(undefined, true);
  expect(first.create).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
  expect(first.place.worktreeName).toBe("first-task");
  expect(first.flow.pendingPlacement).toMatchObject({
    createParams: { worktreeName: "first-task" },
    phase: "creating",
  });
  const original = first.create.mock.calls[0]![0];
  if (restored) {
    disposeWorktreeDraft(first);
  }
  const retry = restored ? await namedWorktreeFixture(true, true) : first;
  if (restored) {
    expect(retry.flow.pendingPlacement.sessionKey).toBe(original!.key);
    expect(retry.place.worktreeName).toBe("");
  }
  retry.context.placementStartup.start = start;
  acceptIdlePlacement(retry);
  expect(retry.flow.submitDisabledReason()).toBeUndefined();
  await retry.flow.submit(undefined, true);
  expect(retry.create).toHaveBeenCalledTimes(restored ? 1 : 2);
  expect(retry.create).toHaveBeenLastCalledWith(original, backgroundCreateOptions);
  expect(start).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      recovery: expect.objectContaining({ sessionKey: original!.key, phase: "dispatching" }),
      persistRecovery: true,
    }),
  );
  expectWorktreeName(retry.place);
});
