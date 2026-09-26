import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import * as toast from "../../lib/toast.ts";
import { CHAT_ROUTE_READY_EVENT } from "../chat/chat-history-events.ts";
import { identityPreferences } from "./draft-worktree-preferences.test-support.ts";
import { renderControl } from "./model-control.test-support.ts";
import { loadNewSessionPreference } from "./preferences.ts";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

it.each([false, true])(
  "consumes the accepted name while preserving newer model controls, identity=%s",
  async (identified) => {
    const prefs = identityPreferences(identified, async () => ({
      models: [
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          reasoning: true,
          thinkingLevels: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
      ],
    }));
    const first = prefs.make();
    await prefs.ready(first);
    const admitted = createDeferred<SessionCreateOutcome>();
    vi.mocked(first.context.sessions.createResult).mockReturnValue(admitted.promise);
    first.flow.setMessage("first task");
    const submitting = first.flow.submit(undefined, true);
    await vi.waitFor(() => expect(first.context.sessions.createResult).toHaveBeenCalledOnce());
    const next = prefs.make(first.context.gateway);
    await prefs.ready(next);
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
      .querySelector<HTMLButtonElement>("[data-chat-speed-toggle]")!
      .click();
    const selected = { model: "openai/gpt-5.6-sol", thinkingLevel: "high", fastMode: true };
    await vi.waitFor(() => expect(prefs.stored()).toMatchObject(selected));
    admitted.resolve({
      key: "agent:main:dashboard:first",
      initialRun: { status: "started", runId: "first-run" },
    });
    await submitting;
    expect(next.place.worktreeName).toBe("");
    expect(prefs.stored()).toMatchObject(selected);
    expect(loadNewSessionPreference("ws://gateway.example", "main")?.worktreeName).toBeUndefined();
    expect(control.selected).toBe(selected.model);
    expect(control.thinkingLevel).toBe(selected.thinkingLevel);
    expect(control.fastMode).toBe(selected.fastMode);
  },
);

it("retires the accepted placement name when its view is disposed during composer retirement", async () => {
  const prefs = identityPreferences();
  const first = prefs.make();
  await prefs.ready(first);
  vi.spyOn(first.gateway, "cloudProfiles", "get").mockReturnValue([
    { id: "cloud", providerId: "crabbox", executionModes: ["worker-turn", "remote-exec"] },
  ]);
  vi.spyOn(first.gateway, "cloudProfilesReady", "get").mockReturnValue(true);
  vi.spyOn(first.gateway, "cloudProfilesPending", "get").mockReturnValue(false);
  first.place.selectCloudProfile("cloud");
  const start = vi.fn(() => {
    queueMicrotask(() => {
      first.flow.invalidate();
      first.gateway.disconnect();
      first.place.browser.disconnect();
      first.flow.disconnect();
    });
  });
  first.context.placementStartup.start = start;
  vi.mocked(first.context.sessions.createResult).mockImplementation(async (params) => ({
    key: params!.key!,
    initialRun: { status: "idle" },
  }));
  first.flow.setMessage("first task");
  await first.flow.submit(undefined, true);
  expect(first.context.sessions.createResult).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
  expect(first.context.navigateAndWait).not.toHaveBeenCalled();
  expect(first.request.mock.calls.some(([method]) => method === "agent.wait")).toBe(false);
  const next = prefs.make(first.context.gateway);
  await prefs.ready(next);
  expect(loadNewSessionPreference("ws://gateway.example", "main")?.worktreeName).toBeUndefined();
  expect(prefs.stored()).toMatchObject({ worktreeName: "" });
});

it("commits identified-user name consumption before navigation disposes the draft", async () => {
  const prefs = identityPreferences();
  const first = prefs.make();
  await prefs.ready(first);
  expect(first.place.worktreeName).toBe("first-task");
  const clear = createDeferred();
  prefs.beforeSave.mockImplementation(async () => clear.promise);
  vi.mocked(first.context.sessions.createResult).mockResolvedValue({
    key: "agent:main:dashboard:first",
    initialRun: { status: "started", runId: "first-run" },
  });
  vi.mocked(first.context.navigateAndWait).mockImplementation(async () => {
    first.gateway.disconnect();
    first.place.browser.disconnect();
    first.flow.disconnect();
    queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
  });
  first.flow.setMessage("first task");
  const submitting = first.flow.submit();
  await vi.waitFor(() =>
    expect(
      prefs.beforeSave.mock.calls.length +
        vi.mocked(first.context.navigateAndWait).mock.calls.length,
    ).toBeGreaterThan(0),
  );
  const navigatedBeforeSave = vi.mocked(first.context.navigateAndWait).mock.calls.length;
  clear.resolve();
  await submitting;
  expect(navigatedBeforeSave).toBe(0);
  expect(first.context.navigateAndWait).toHaveBeenCalledOnce();
  const next = prefs.make(first.context.gateway);
  await prefs.ready(next);
  expect(next.place.worktreeName).toBe("");
  expect(loadNewSessionPreference("ws://gateway.example", "main")?.worktreeName).toBeUndefined();
});

it.each([
  { identified: false, disposed: false },
  { identified: false, disposed: true },
  { identified: true, disposed: false },
  { identified: true, disposed: true },
])(
  "late acceptance preserves another draft's name with identity=$identified, disposed=$disposed",
  async ({ identified, disposed }) => {
    const prefs = identityPreferences(identified);
    const first = prefs.make();
    await prefs.ready(first);
    const admitted = createDeferred<SessionCreateOutcome>();
    vi.mocked(first.context.sessions.createResult).mockReturnValue(admitted.promise);
    first.flow.setMessage("first task");
    const submitting = first.flow.submit(undefined, true);
    await vi.waitFor(() => expect(first.context.sessions.createResult).toHaveBeenCalledOnce());
    if (disposed) {
      first.gateway.disconnect();
      first.place.browser.disconnect();
      first.flow.disconnect();
    }
    const next = prefs.make(first.context.gateway);
    await prefs.ready(next);
    next.place.setWorktreeName("next-task");
    await vi.waitFor(() => expect(prefs.stored()).toMatchObject({ worktreeName: "next-task" }));
    admitted.resolve({
      key: "agent:main:dashboard:first",
      initialRun: { status: "started", runId: "first-run" },
    });
    await submitting;
    expect(next.place.worktreeName).toBe("next-task");
    expect(prefs.stored()).toMatchObject({ worktreeName: "next-task" });
  },
);

it.each([false, true])(
  "retires accepted name after source disposal without newer edits, identity=%s",
  async (identified) => {
    const prefs = identityPreferences(identified);
    const first = prefs.make();
    await prefs.ready(first);
    const admitted = createDeferred<SessionCreateOutcome>();
    vi.mocked(first.context.sessions.createResult).mockReturnValue(admitted.promise);
    first.flow.setMessage("first task");
    const submitting = first.flow.submit(undefined, true);
    await vi.waitFor(() => expect(first.context.sessions.createResult).toHaveBeenCalledOnce());
    first.flow.invalidate("gateway-changed");
    first.place.invalidateGatewayDiscovery(true);
    first.gateway.disconnect();
    first.place.browser.disconnect();
    first.flow.disconnect();
    const next = prefs.make(first.context.gateway);
    await prefs.ready(next);
    expect(next.place.worktreeName).toBe("first-task");
    admitted.resolve({
      key: "agent:main:dashboard:first",
      initialRun: { status: "started", runId: "first-run" },
    });
    await submitting;
    expect(next.place.worktreeName).toBe("");
    expect(first.context.navigateAndWait).not.toHaveBeenCalled();
  },
);

it.each(["hello", "client"])(
  "does not retire the former principal's name when %s identity changes first",
  async (changed) => {
    const prefs = identityPreferences();
    const first = prefs.make();
    await prefs.ready(first);
    const admitted = createDeferred<SessionCreateOutcome>();
    vi.mocked(first.context.sessions.createResult).mockReturnValue(admitted.promise);
    first.flow.setMessage("first task");
    const submitting = first.flow.submit(undefined, true);
    await vi.waitFor(() => expect(first.context.sessions.createResult).toHaveBeenCalledOnce());
    Object.assign(
      changed === "hello"
        ? first.context.gateway.snapshot.hello!.auth!
        : first.context.gateway.snapshot.client!,
      { recoveryScope: "principal-b" },
    );
    admitted.resolve({
      key: "agent:main:dashboard:first",
      initialRun: { status: "started", runId: "first-run" },
    });
    await submitting;
    expect(prefs.stored()).toMatchObject({ worktreeName: "first-task" });
  },
);

it.each([false, true])(
  "placement clear cannot navigate or notify a newer route, background=%s",
  async (background) => {
    const prefs = identityPreferences();
    const first = prefs.make();
    await prefs.ready(first);
    vi.spyOn(first.gateway, "cloudProfiles", "get").mockReturnValue([
      { id: "cloud", providerId: "crabbox", executionModes: ["worker-turn", "remote-exec"] },
    ]);
    vi.spyOn(first.gateway, "cloudProfilesReady", "get").mockReturnValue(true);
    vi.spyOn(first.gateway, "cloudProfilesPending", "get").mockReturnValue(false);
    first.place.selectCloudProfile("cloud");
    const start = vi.fn();
    first.context.placementStartup.start = start;
    vi.mocked(first.context.sessions.createResult).mockImplementation(async (params) => ({
      key: params!.key!,
      initialRun: { status: "idle" },
    }));
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
    first.flow.setMessage("first task");
    expect(first.flow.submitDisabledReason()).toBeUndefined();
    const submitting = first.flow.submit(undefined, background);
    await clearStarted.promise;
    expect(start).toHaveBeenCalledOnce();
    first.flow.invalidate();
    first.gateway.disconnect();
    clear.resolve();
    await submitting;
    expect(first.context.navigateAndWait).not.toHaveBeenCalled();
    expect(first.request.mock.calls.some(([method]) => method === "agent.wait")).toBe(false);
  },
);

it.each([{ worktreeName: "hydrated-task" }, { folder: "/other-repo" }, { baseRef: "next-base" }])(
  "late acceptance preserves a newer hydrated repository preference: %j",
  async (patch) => {
    const prefs = identityPreferences();
    const first = prefs.make();
    await prefs.ready(first);
    const admitted = createDeferred<SessionCreateOutcome>();
    vi.mocked(first.context.sessions.createResult).mockReturnValue(admitted.promise);
    first.flow.setMessage("first task");
    const submitting = first.flow.submit(undefined, true);
    await vi.waitFor(() => expect(first.context.sessions.createResult).toHaveBeenCalledOnce());
    await prefs.publish(first, patch);
    const next = prefs.make(first.context.gateway);
    await prefs.ready(next);
    const before = structuredClone(prefs.stored());
    admitted.resolve({
      key: "agent:main:dashboard:first",
      initialRun: { status: "started", runId: "first-run" },
    });
    await submitting;
    expect(prefs.stored()).toEqual(before);
    expect(next.place.worktreeName).toBe(patch.worktreeName ?? "first-task");
  },
);

it.each(["name", "base"])(
  "orders an accepted clear before a newer controller's %s edit",
  async (edit) => {
    const prefs = identityPreferences();
    const first = prefs.make();
    await prefs.ready(first);
    const next = prefs.make(first.context.gateway);
    await prefs.ready(next);
    const observer = prefs.make(first.context.gateway);
    await prefs.ready(observer);
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
    vi.mocked(first.context.sessions.createResult).mockResolvedValue({
      key: "agent:main:dashboard:first",
      initialRun: { status: "started", runId: "first-run" },
    });
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
  const first = prefs.make();
  await prefs.ready(first);
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
    const first = prefs.make();
    await prefs.ready(first);
    const observer = prefs.make(first.context.gateway);
    await prefs.ready(observer);
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
    const next = prefs.make(first.context.gateway);
    await prefs.ready(next);
    expect(next.place.baseRef).toBe(baseRef);
    expect(next.place.worktreeName).toBe("first-task");
  },
);

it("retires the submitted agent preference while the same view has selected another agent", async () => {
  const prefs = identityPreferences();
  const first = prefs.make();
  await prefs.ready(first);
  const admitted = createDeferred<SessionCreateOutcome>();
  vi.mocked(first.context.sessions.createResult).mockReturnValue(admitted.promise);
  first.flow.setMessage("first task");
  const submitting = first.flow.submit(undefined, true);
  await vi.waitFor(() => expect(first.context.sessions.createResult).toHaveBeenCalledOnce());
  first.flow.invalidate();
  first.flow.resetDraft();
  first.place.selectAgentId("work");
  expect(first.place.worktreeName).toBe("work-task");
  const workPreference = structuredClone(prefs.stored("work"));
  admitted.resolve({
    key: "agent:main:dashboard:first",
    initialRun: { status: "started", runId: "first-run" },
  });
  await submitting;
  expect(prefs.stored()).toMatchObject({ worktreeName: "" });
  expect(prefs.stored("work")).toEqual(workPreference);
  expect(first.place.agentId).toBe("work");
  expect(first.place.worktreeName).toBe("work-task");
  expect(first.context.navigateAndWait).not.toHaveBeenCalled();
});

it("does not let a replacement draft's pending preference load restore a consumed name", async () => {
  const prefs = identityPreferences();
  const first = prefs.make();
  await prefs.ready(first);
  const clear = createDeferred();
  const clearStarted = createDeferred();
  prefs.beforeSave.mockImplementation(async () => {
    clearStarted.resolve();
    await clear.promise;
  });
  vi.mocked(first.context.sessions.createResult).mockResolvedValue({
    key: "agent:main:dashboard:first",
    initialRun: { status: "started", runId: "first-run" },
  });
  first.flow.setMessage("first task");
  const submitting = first.flow.submit(undefined, true);
  await clearStarted.promise;
  first.gateway.disconnect();
  first.place.browser.disconnect();
  first.flow.disconnect();
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

it.each(["read", "save", "transport"] as const)(
  "warns without reversing an accepted session when preference %s fails",
  async (failure) => {
    const prefs = identityPreferences();
    const fixture = prefs.make();
    await prefs.ready(fixture);
    const warning = vi.spyOn(toast, "showToast").mockReturnValue(false);
    vi.mocked(fixture.context.navigateAndWait).mockImplementation(async () => {
      queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
    });
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
    // Start from a fresh authoritative read, as the writer does after preceding edits.
    const { invalidateUserPreferences } = await import("../../app/user-prefs-cache.ts");
    invalidateUserPreferences(fixture.context.gateway.snapshot.client!);
    vi.mocked(fixture.context.sessions.createResult).mockResolvedValue({
      key: "agent:main:dashboard:first",
      initialRun: { status: "started", runId: "first-run" },
    });
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
    expect(loadNewSessionPreference("ws://gateway.example", "main")).toMatchObject({
      worktreeName: "first-task",
    });
  },
);

it("warns without reversing accepted creation when local preference storage rejects the clear", async () => {
  const prefs = identityPreferences(false);
  const fixture = prefs.make();
  await prefs.ready(fixture);
  const warning = vi.spyOn(toast, "showToast").mockReturnValue(false);
  vi.mocked(fixture.context.navigateAndWait).mockImplementation(async () => {
    queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
  });
  const write = localStorage.setItem.bind(localStorage);
  const rejectedWrite = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
    if (key.includes("new-session")) {
      throw new Error("Synthetic browser quota exceeded");
    }
    return write(key, value);
  });
  vi.mocked(fixture.context.sessions.createResult).mockResolvedValue({
    key: "agent:main:dashboard:first",
    initialRun: { status: "started", runId: "first-run" },
  });
  fixture.flow.setMessage("first task");
  await fixture.flow.submit();
  expect(fixture.context.sessions.createResult).toHaveBeenCalledOnce();
  expect(fixture.context.navigateAndWait).toHaveBeenCalledOnce();
  expect(fixture.flow.error).toBeNull();
  expect(rejectedWrite).toHaveBeenCalledWith(
    expect.stringContaining("new-session.preferences"),
    expect.any(String),
  );
  expect(warning).toHaveBeenCalledExactlyOnceWith({
    message:
      "Session accepted, but clearing the saved worktree name could not be confirmed. Check Name before starting another worktree.",
  });
  expect(prefs.stored()).toMatchObject({ worktreeName: "first-task" });
});

it("retires the restored placement's agent preference even when the picker hydrates the default agent", async () => {
  const prefs = identityPreferences();
  const first = prefs.make();
  await prefs.ready(first);
  first.place.selectAgentId("work");
  await vi.waitFor(() => expect(first.place.worktreeName).toBe("work-task"));
  vi.spyOn(first.gateway, "cloudProfiles", "get").mockReturnValue([
    { id: "cloud", providerId: "crabbox", executionModes: ["worker-turn", "remote-exec"] },
  ]);
  vi.spyOn(first.gateway, "cloudProfilesReady", "get").mockReturnValue(true);
  vi.spyOn(first.gateway, "cloudProfilesPending", "get").mockReturnValue(false);
  first.place.selectCloudProfile("cloud");
  first.flow.setMessage("work task");
  vi.mocked(first.context.sessions.createResult).mockResolvedValue(null);
  await first.flow.submit(undefined, true);
  expect(first.flow.pendingPlacement.phase).toBe("creating");
  const original = vi.mocked(first.context.sessions.createResult).mock.calls[0]![0];
  expect(original).toMatchObject({ agentId: "work", worktreeName: "work-task" });
  first.gateway.disconnect();
  first.place.browser.disconnect();
  first.flow.disconnect();
  const retry = prefs.make(first.context.gateway);
  await prefs.ready(retry);
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
