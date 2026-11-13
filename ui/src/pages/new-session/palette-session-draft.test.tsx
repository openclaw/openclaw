/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { AgentSelectElement } from "../../components/agent-select.tsx";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { writeSessionPlacementRecovery } from "../../lib/sessions/session-placement-recovery.ts";
import * as toast from "../../lib/toast.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import {
  mount as mountDraft,
  PaletteDraftHost,
} from "../../test-helpers/palette-session-draft.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { NewSessionDraftPersistence } from "./draft-persistence.ts";
import {
  backgroundCreateOptions,
  createDraftFixture,
} from "./draft-submission-flow.test-support.ts";
import { PALETTE_PREFERENCE_KEY, PREFS_MIGRATION_KEY } from "./preferences.ts";

async function mount(...options: Parameters<typeof mountDraft>) {
  const fixture = await mountDraft(...options);
  return { ...fixture, create: vi.mocked(fixture.context.sessions.createResult) };
}

function setting(host: Pick<ParentNode, "querySelector">, part: string) {
  return host.querySelector<HTMLElement>(".palette-session-settings__" + part);
}

function reopen(host: PaletteDraftHost) {
  host.draft.close();
  host.paletteOpen = true;
  host.draft.open();
}

async function submit(host: PaletteDraftHost, message: string) {
  host.draft.setMessage(message);
  await vi.waitFor(() => expect(host.draft.canSubmit).toBe(true));
  await host.draft.submit();
}

function agent(host: PaletteDraftHost) {
  return expectDefined(host.querySelector<AgentSelectElement>("openclaw-agent-select"), "agent");
}

async function preservePrompt(host: PaletteDraftHost) {
  host.draft.setMessage("Keep this exact prompt");
  await host.updateComplete;
  const prompt = expectDefined(host.querySelector("textarea"), "prompt");
  prompt.focus();
  prompt.setSelectionRange(5, 9);
  return () => {
    expect(host.draft.message).toBe("Keep this exact prompt");
    expect(host.querySelector("textarea")).toBe(prompt);
    expect([prompt.selectionStart, prompt.selectionEnd]).toEqual([5, 9]);
  };
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("PaletteSessionDraft", () => {
  it("carries one cold Send through required profile publication", async () => {
    const policy = createDeferred<unknown>();
    const submitted = createDeferred();
    const profile = {
      id: "dedicated",
      providerId: "device",
      inference: "worker",
      executionModes: ["worker-turn"],
    };
    const { host, context, create } = await mount({
      methods: ["agents.list", "environments.list", "sessions.create", "sessions.send"],
      placementPolicy: () => policy.promise,
    });
    create.mockResolvedValue({
      key: "agent:main:dashboard:cold-required",
      initialRun: { status: "idle" },
    });
    vi.mocked(context.placementStartup.start).mockImplementation(() => submitted.resolve());
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      Object.defineProperty(this, "result", { value: "data:text/plain;base64,Y29sZA==" });
      this.dispatchEvent(new ProgressEvent("load"));
    });
    host.draft.setMessage("Carry my cold Send into the required worker");
    host.draft.adoptAttachmentFiles([
      new File(["cold attachment"], "cold.txt", { type: "text/plain" }),
    ]);
    await waitForSolid(() => {
      expect(
        host.querySelector('.chat-attachment-thumb[aria-busy="false"]')?.textContent,
      ).toContain("cold.txt");
    });
    host.observeColdSubmission = true;
    host.draft.submitCold();
    await host.updateComplete;
    expect(host.draft.messageLocked).toBe(true);
    expect(create).not.toHaveBeenCalled();
    policy.resolve({ sessionPlacement: { requiredProfile: profile } });
    await context.agents.refreshList();
    await host.coldOutcome.promise;
    // The cold Send starts once and releases the launcher to its own draft.
    expect(host.paletteOpen).toBe(false);
    expect(host.draft).toMatchObject({ submitting: false, messageLocked: false, error: null });
    await submitted.promise;
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "", worktree: true, worktreeSource: "empty" }),
      backgroundCreateOptions,
    );
    expect(context.placementStartup.start).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: expect.objectContaining({
          message: "Carry my cold Send into the required worker",
          target: { kind: "profile", profileId: profile.id, required: true },
          attachments: [expect.objectContaining({ fileName: "cold.txt", mimeType: "text/plain" })],
        }),
      }),
    );
  });

  it("does not auto-submit after a synchronous attachment read failure", async () => {
    const { host, create } = await mount();
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(() => {
      throw new Error("Read failed");
    });
    host.draft.setMessage("Keep this prompt after the attachment fails.");
    host.draft.adoptAttachmentFiles(
      [new File(["payload"], "unreadable.txt", { type: "text/plain" })],
      true,
    );
    await waitForSolid(() => expect(host.draft.messageLocked).toBe(false));
    expect(create).not.toHaveBeenCalled();
    expect(host.draft.message).toBe("Keep this prompt after the attachment fails.");
    expect(host.querySelector(".chat-attachment-thumb")).toBeNull();
    await waitForSolid(() => expect(host.draft.canSubmit).toBe(true));
    await host.draft.submit();
    expect(create).toHaveBeenCalledOnce();
  });

  it("omits needless agent and effort controls and the non-Git worktree setting", async () => {
    const { host } = await mount();
    await vi.waitFor(() => expect(setting(host, "trigger")).not.toBeNull());
    expect(host.querySelector('[role="switch"][aria-label="New worktree"]')).toBeNull();
    expect(host.querySelector("openclaw-agent-select")).toBeNull();
    expect(host.querySelector(".chat-controls__effort-picker")).toBeNull();
    expect(host.querySelector("[data-chat-model-select]")).not.toBeNull();
  });

  it("loads identities for both visible agent choices and only the selection after closing", async () => {
    const { host, context } = await mount({
      agents: [
        { id: "main", workspace: "/workspace" },
        { id: "other", workspace: "/other" },
      ],
    });
    const picker = agent(host);
    await picker.updateComplete;
    const trigger = expectDefined(
      picker.querySelector<HTMLButtonElement>(".agent-select__trigger"),
      "agent picker trigger",
    );
    const menu = expectDefined(picker.querySelector(".agent-select__menu"), "agent menu");
    const ensure = vi.mocked(context.agentIdentity.ensure);
    const requestedIds = () =>
      [...new Set(ensure.mock.calls.flatMap(([ids]) => ids))].toSorted((a, b) =>
        (a ?? "").localeCompare(b ?? ""),
      );
    await waitForSolid(() => expect(ensure).toHaveBeenLastCalledWith(["main"]));

    ensure.mockClear();
    trigger.click();
    await waitForSolid(() => {
      expect(menu.matches(":popover-open")).toBe(true);
      expect(picker.querySelectorAll("[data-agent-option]")).toHaveLength(2);
      expect(requestedIds()).toEqual(["main", "other"]);
    });

    ensure.mockClear();
    trigger.click();
    await waitForSolid(() => {
      expect(menu.matches(":popover-open")).toBe(false);
      expect(picker.querySelector("[data-agent-option]")).toBeNull();
      expect(requestedIds()).toEqual(["main"]);
    });
  });

  it("selects a hosted workspace in palette settings without cloning or dispatching a project", async () => {
    const model = {
      id: "gpt-5.6-luna",
      name: "Luna",
      provider: "openai",
      available: true,
      agentRuntime: { id: "openclaw", source: "model" },
      runtimeChoices: [
        {
          agentRuntime: {
            id: "agentsapi",
            source: "model",
            workspaceEnvironment: { kind: "provider-hosted", label: "OpenAI (Agents API)" },
          },
          available: true,
        },
      ],
    };
    const { host, create, request } = await mount({
      modelCatalog: async () => ({ models: [model] }),
      methods: ["agents.list", "environments.list", "sessions.create", "projects.list"],
      request: async (method) =>
        method === "projects.list"
          ? {
              projects: [
                {
                  id: "registered",
                  displayName: "Local project",
                  repoRoot: "/local/project",
                  source: "registered",
                },
              ],
            }
          : {},
    });
    const select = async (machine: string, project = "") => {
      await vi.waitFor(() => expect(setting(host, "trigger")).not.toBeNull());
      expectDefined(setting(host, "trigger"), "workspace picker").click();
      await host.updateComplete;
      const row = () =>
        host.querySelector<HTMLButtonElement>(
          `[data-machine="${machine}"][data-project="${project}"]`,
        );
      await vi.waitFor(() => expect(row()).not.toBeNull());
      expectDefined(row(), "environment choice").click();
      await host.updateComplete;
    };

    await select("local", "registered");
    await select("runtime:agentsapi");
    expect(setting(host, "trigger")?.textContent).toContain("Hosted workspace");
    expect(
      host.querySelector('[data-machine="runtime:agentsapi"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(setting(host, "worktree")).toBeNull();
    await select("local", "registered");
    expect(setting(host, "trigger")?.textContent).toContain("Local project");
    expect(setting(host, "trigger")?.textContent).not.toContain("Agents API");
    await select("runtime:agentsapi");
    create.mockResolvedValue({
      key: "agent:main:hosted-palette",
      initialRun: { status: "idle" },
    });
    await submit(host, "Analyze my attachment");
    const payload = create.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      model: "openai/gpt-5.6-luna",
      agentRuntime: "agentsapi",
      message: "Analyze my attachment",
    });
    for (const key of [
      "projectId",
      "projectGitUrl",
      "repository",
      "cwd",
      "worktree",
      "catalogId",
    ]) {
      expect(payload).not.toHaveProperty(key);
    }
    expect(
      request.mock.calls.some(
        ([method]) => method === "sessions.dispatch" || method === "projects.add",
      ),
    ).toBe(false);
  });

  it("frees the launcher for another start while one is pending and retries a failed start", async () => {
    const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
    const { host, create } = await mount();
    const first = createDeferred<SessionCreateOutcome>();
    const second = createDeferred<SessionCreateOutcome>();
    create.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    host.draft.setMessage("Start this while I keep working");
    await vi.waitFor(() => expect(host.draft.canSubmit).toBe(true));
    const firstSubmission = host.draft.submit();
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(host.paletteOpen).toBe(false);
    expect(host.draft).toMatchObject({ message: "", submitting: false, messageLocked: false });

    host.paletteOpen = true;
    host.draft.open();
    host.draft.setMessage("A second task in parallel");
    await vi.waitFor(() => expect(host.draft.canSubmit).toBe(true));
    const secondSubmission = host.draft.submit();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls.map(([params]) => params?.message)).toEqual([
      "Start this while I keep working",
      "A second task in parallel",
    ]);

    first.reject(new Error("Gateway refused the session"));
    await firstSubmission;
    const notice = showToast.mock.calls.at(-1)?.[0];
    expect(notice).toMatchObject({
      message: "Couldn’t start the session. Try again. Gateway refused the session",
      actionLabel: "Try again",
    });
    create.mockResolvedValueOnce({
      key: "agent:main:dashboard:retried",
      initialRun: { status: "started", runId: "retried-run" },
    });
    notice?.onAction?.();
    // A retry while the first attempt is still settling must not start twice.
    notice?.onAction?.();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    expect(create.mock.calls[2]?.[0]?.message).toBe("Start this while I keep working");
    await vi.waitFor(() =>
      expect(showToast).toHaveBeenLastCalledWith(
        expect.objectContaining({ actionLabel: "Open session" }),
      ),
    );
    second.resolve({ key: "agent:main:dashboard:second", initialRun: { status: "idle" } });
    await secondSubmission;
    expect(create).toHaveBeenCalledTimes(3);
    expect(host.draft.message).toBe("");
  });

  it.each([
    { status: "started", message: "Session started" },
    { status: "idle", message: "Session created" },
  ] as const)("confirms $status session creation", async ({ status, message }) => {
    const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
    const { host, create } = await mount();
    create.mockResolvedValue({
      key: "agent:main:dashboard:created",
      initialRun: { status },
    });
    host.draft.setMessage("Start a new session");
    await vi.waitFor(() => expect(host.draft.canSubmit).toBe(true));
    await host.draft.submit();
    expect(showToast).toHaveBeenCalledExactlyOnceWith({
      message,
      dedupeKey: "session-create:main:agent:main:dashboard:created",
      severity: "success",
      actionLabel: "Open session",
      onAction: expect.any(Function),
    });
  });

  it.each(["unchanged", "connection", "account"] as const)(
    "settles one released creation when its owner is %s",
    async (change) => {
      const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
      const { host, context, create, publish } = await mount();
      const accepted = createDeferred<SessionCreateOutcome>();
      create.mockReturnValueOnce(accepted.promise);
      host.draft.setMessage("Hold my creation");
      await vi.waitFor(() => expect(host.draft.canSubmit).toBe(true));
      const submission = host.draft.submit();
      await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
      try {
        if (change === "unchanged") {
          host.paletteOpen = true;
          host.draft.open();
          expect(host.draft).toMatchObject({ message: "", submitting: false });
        } else {
          if (change === "connection") {
            Object.assign(context.gateway, { connectionRevision: 2 });
          } else {
            const hello = expectDefined(context.gateway.snapshot.hello, "connected Gateway hello");
            Object.assign(context.gateway.snapshot, {
              selfUser: { id: "another-user" },
              hello: { ...hello, auth: { ...hello.auth, recoveryScope: "another-owner" } },
            });
            Object.assign(context.gateway.snapshot.client!, { recoveryScope: "another-owner" });
          }
          publish();
          await host.updateComplete;
          await host.updateComplete;
          host.paletteOpen = true;
          host.draft.open();
          expect(host.draft.message).toBe("");
        }
      } finally {
        accepted.resolve({ key: "agent:main:dashboard:held", initialRun: { status: "idle" } });
        await submission;
      }
      expect(create).toHaveBeenCalledOnce();
      // Release closes the launcher once; acceptance never closes a newer prompt.
      expect(host.started).toHaveBeenCalledOnce();
      expect(host.paletteOpen).toBe(true);
      expect(context.navigateAndWait).not.toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0);
    },
  );

  it.each(["same-owner", "gateway-object", "disconnected"])(
    "keeps a rejected session's notice bound to its owner after %s reconnect",
    async (reconnect) => {
      const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
      const { host, context, create, publish } = await mount();
      create.mockResolvedValue({
        key: "agent:main:dashboard:rejected",
        initialRun: { status: "rejected", error: "Initial turn rejected" },
      });
      await submit(host, "Keep the rejected task recoverable");
      // The destination session owns the rejected prompt and its retry.
      expect(host.draft.message).toBe("");
      const notice = showToast.mock.calls.at(-1)?.[0];
      expect(notice).toMatchObject({
        message: "Session created, but couldn't start: Initial turn rejected",
        dedupeKey: "session-create:main:agent:main:dashboard:rejected",
        severity: "error",
      });
      context.gateway.snapshot.phase = "reconnecting";
      publish();
      context.gateway.snapshot.client = createDraftFixture().context.gateway.snapshot.client;
      context.gateway.snapshot.phase = reconnect === "disconnected" ? "reconnecting" : "connected";
      if (reconnect === "gateway-object") {
        Object.assign(context, { gateway: { ...context.gateway } });
      }
      publish();
      await host.updateComplete;
      notice?.onAction?.();
      if (reconnect === "same-owner") {
        expect(context.gateway.setSessionKey).toHaveBeenCalledWith("agent:main:dashboard:rejected");
        expect(context.navigate).toHaveBeenCalledOnce();
      } else {
        expect(context.navigate).not.toHaveBeenCalled();
        expect(context.gateway.setSessionKey).not.toHaveBeenCalled();
      }
      expect(create).toHaveBeenCalledOnce();
    },
  );

  it("never binds full-page durable drafts or adopts their orphaned creating placement", async () => {
    const owner = vi.spyOn(NewSessionDraftPersistence.prototype, "setOwner");
    const route = vi.spyOn(NewSessionDraftPersistence.prototype, "activateRoute");
    expect(
      writeSessionPlacementRecovery({
        sessionKey: "agent:main:dashboard:page-owned",
        messageId: "page-message",
        message: "Full page draft",
        target: { kind: "device", deviceId: "runner" },
        agentId: "main",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "creating",
        createParams: {
          key: "agent:main:dashboard:page-owned",
          agentId: "main",
          message: "",
          worktree: true,
        },
      }),
    ).toBe(true);
    const { host } = await mount();
    host.draft.setMessage("Launcher draft");
    await host.updateComplete;
    expect(host.draft.message).toBe("Launcher draft");
    expect(owner).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(1);
    expect(host.querySelector(".new-session-page__where-popover")).toBeNull();
    const settingsTrigger = setting(host, "trigger");
    expect(settingsTrigger?.id).toMatch(/^palette-session-\d+-settings-trigger$/);
    expect(settingsTrigger?.getAttribute("aria-controls")).toBe(
      host.querySelector(".oc-popover.palette-session-settings")?.id,
    );
  });
});

async function mountPreferences(initial: Record<string, unknown> = {}) {
  const entries: Record<string, unknown> = { [PREFS_MIGRATION_KEY]: true, ...initial };
  const writes: Record<string, unknown>[] = [];
  let reject = false;
  let beforeSave = async (_patch: Record<string, unknown>) => {};
  const fixture = await mount({
    selfUser: { id: "alice" },
    modelCatalog: async () => ({
      models: ["main", "other", "fast"].map((id) => ({
        id,
        provider: "example",
        name: id,
        available: true,
      })),
    }),
    agents: ["main", "other"].map((id) => ({
      id,
      workspace: id === "main" ? "/workspace" : "/other",
      workspaceGit: true,
      model: { primary: "example/" + id },
    })),
    methods: [
      "sessions.create",
      "users.prefs.get",
      "users.prefs.set",
      "worktrees.branches",
      "projects.list",
    ],
    request: async (method, params) => {
      if (method === "users.prefs.get") {
        return { status: "ok", entries: structuredClone(entries) };
      }
      if (method === "users.prefs.set") {
        if (!isRecord(params) || !isRecord(params.entries)) {
          throw new Error("Expected preference entries");
        }
        writes.push(params.entries);
        if (reject) {
          throw new Error("Preference save failed");
        }
        await beforeSave(params.entries);
        for (const [key, value] of Object.entries(params.entries)) {
          if (value === null) {
            delete entries[key];
          } else {
            entries[key] = value;
          }
        }
        return { status: "ok" };
      }
      if (method === "worktrees.branches") {
        return {
          repositoryStatus: "git",
          repoRoot: isRecord(params) ? params.repoRoot : "/workspace",
          branches: [{ name: "main", kind: "local" }],
          headBranch: "main",
        };
      }
      if (method === "projects.list") {
        return { projects: [] };
      }
      if (method === "fs.listDir") {
        return { path: isRecord(params) ? params.path : "/workspace", entries: [] };
      }
      return {};
    },
  });
  const { host } = fixture;
  const select = () => agent(host);
  const worktree = () =>
    expectDefined(host.querySelector<HTMLButtonElement>('[role="switch"]'), "worktree");
  // Wait out cold preference imports, then flush their queued presentation updates.
  await fixture.host.settingsReady.promise;
  await waitForSolid(() => {
    expect(worktree().disabled).toBe(false);
  });
  return {
    ...fixture,
    entries,
    writes,
    select,
    worktree,
    choose: async (id: string) => {
      await vi.waitFor(() => expect(host.querySelector("openclaw-agent-select")).not.toBeNull());
      select().onSelect(id);
      await host.updateComplete;
    },
    reconnect: async () => {
      fixture.context.gateway.snapshot.phase = "reconnecting";
      fixture.publish();
      await host.updateComplete;
      fixture.context.gateway.snapshot.phase = "connected";
      fixture.context.gateway.snapshot.hello = {
        ...expectDefined(fixture.context.gateway.snapshot.hello, "hello"),
      };
      fixture.publish();
      await host.updateComplete;
    },
    setReject: (value: boolean) => {
      reject = value;
    },
    setBeforeSave: (callback: (patch: Record<string, unknown>) => Promise<void>) => {
      beforeSave = callback;
    },
  };
}

function holdPaletteSave(fixture: Awaited<ReturnType<typeof mountPreferences>>) {
  const saving = createDeferred();
  const held = createDeferred();
  let heldOnce = false;
  fixture.setBeforeSave(async (patch) => {
    if (Object.hasOwn(patch, PALETTE_PREFERENCE_KEY) && !heldOnce) {
      heldOnce = true;
      saving.resolve();
      await held.promise;
    }
  });
  return { saving: saving.promise, release: held.resolve };
}

describe("palette-only last-used settings", () => {
  it("does not borrow the full page runtime for a remembered palette model", async () => {
    const f = await mountPreferences({
      "new-session.v1:main": { model: "example/main", agentRuntime: "openclaw" },
      [PALETTE_PREFERENCE_KEY]: {
        agentId: "main",
        selection: { folder: "/workspace", model: "example/fast" },
      },
    });
    const draft = expectDefined(f.host.draft.settingsView(), "settings").options.draft;
    expect(draft.gateway.readPreference("main")).toMatchObject({
      model: "example/fast",
      agentRuntime: undefined,
    });
  });

  it("remembers accepted palette choices without opting in", async () => {
    const ordinary = { folder: "/workspace", worktree: true, worktreeName: "foreground-task" };
    const fixture = await mountPreferences({ "new-session.v1:main": ordinary });
    await fixture.choose("other");
    const current = expectDefined(fixture.host.draft.settingsView(), "settings").options.draft;
    current.place.modelControl.selectModel("example/fast");
    fixture.create.mockResolvedValue({
      key: "agent:other:dashboard:remembered",
      initialRun: { status: "idle" },
    });
    await submit(fixture.host, "Use these choices next time");
    await vi.waitFor(() =>
      expect(fixture.entries[PALETTE_PREFERENCE_KEY]).toMatchObject({
        agentId: "other",
        selection: { folder: "/other", model: "example/fast" },
      }),
    );
    expect(fixture.entries["new-session.v1:main"]).toEqual(ordinary);
    expect(Object.keys(fixture.writes[0] ?? {})).toEqual([PALETTE_PREFERENCE_KEY]);
    reopen(fixture.host);
    await vi.waitFor(() => expect(fixture.select().value).toBe("other"));
    expect(setting(fixture.host, "trigger")?.textContent).toContain("other");
    await vi.waitFor(() =>
      expect(fixture.host.draft.settingsView()?.options.draft.place.modelControl.selected).toBe(
        "example/fast",
      ),
    );
  });

  it("does not change last-used settings when browsing, cancelling, or creation fails", async () => {
    const saved = { agentId: "main", selection: { folder: "/workspace", worktree: false } };
    const f = await mountPreferences({ [PALETTE_PREFERENCE_KEY]: saved });
    const checkPrompt = await preservePrompt(f.host);
    await f.choose("other");
    checkPrompt();
    expect(f.writes).toEqual([]);
    reopen(f.host);
    await vi.waitFor(() => expect(f.select().value).toBe("main"));
    await f.choose("other");
    f.create.mockRejectedValueOnce(new Error("Creation refused"));
    await submit(f.host, "This start fails");
    expect(f.entries[PALETTE_PREFERENCE_KEY]).toEqual(saved);
    expect(f.writes).toEqual([]);
  });

  it("never borrows or consumes the foreground draft's one-use worktree name", async () => {
    const ordinary = { folder: "/workspace", worktree: true, worktreeName: "foreground-task" };
    const f = await mountPreferences({
      "new-session.v1:main": ordinary,
      [PALETTE_PREFERENCE_KEY]: {
        agentId: "main",
        selection: { ...ordinary, worktreeName: "old-palette-name" },
      },
    });
    await vi.waitFor(() => expect(f.place.worktreeName).toBe("foreground-task"));
    f.create.mockResolvedValue({
      key: "agent:main:dashboard:worktree",
      initialRun: { status: "idle" },
    });
    await submit(f.host, "A separate background worktree task");
    expect(f.create.mock.calls[0]?.[0]).not.toHaveProperty("worktreeName");
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    const saved = f.entries[PALETTE_PREFERENCE_KEY];
    expect(saved).toMatchObject({ agentId: "main", selection: { worktree: true } });
    expect(isRecord(saved) ? saved.selection : undefined).not.toHaveProperty("worktreeName");
    expect(f.entries["new-session.v1:main"]).toEqual(ordinary);
  });

  it.each(["none", "agent"] as const)(
    "finishes an accepted save across remount without overwriting edited choices (edited=%s)",
    async (edited) => {
      const f = await mountPreferences();
      await f.choose("other");
      f.create.mockResolvedValue({
        key: "agent:other:dashboard:pending-save",
        initialRun: { status: "idle" },
      });
      const held = holdPaletteSave(f);
      let replacement: PaletteDraftHost | undefined;
      try {
        await submit(f.host, "Create before saving preferences finishes");
        await held.saving;
        f.host.remove();
        replacement = new PaletteDraftHost(f.context);
        replacement.draft.open();
        const current = replacement;
        await vi.waitFor(() => expect(agent(current).value).toBe("main"));
        if (edited === "agent") {
          agent(current).onSelect("other");
          await current.updateComplete;
          agent(current).onSelect("main");
          await current.updateComplete;
        }
        held.release();
        await vi.waitFor(() =>
          expect(f.entries[PALETTE_PREFERENCE_KEY]).toMatchObject({ agentId: "other" }),
        );
        await vi.waitFor(() =>
          expect(agent(current).value).toBe(edited === "none" ? "other" : "main"),
        );
      } finally {
        held.release();
        replacement?.remove();
      }
    },
  );

  it("warns when remembering fails without failing creation, then saves the next accepted choice", async () => {
    const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
    const f = await mountPreferences();
    await f.choose("other");
    f.create.mockResolvedValue({
      key: "agent:other:dashboard:saved-session",
      initialRun: { status: "idle" },
    });
    f.setReject(true);
    await submit(f.host, "Create even if preferences cannot be saved");
    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: "warning",
          message: "Session created, but its settings couldn’t be remembered.",
        }),
      ),
    );
    expect(f.entries[PALETTE_PREFERENCE_KEY]).toBeUndefined();
    f.setReject(false);
    reopen(f.host);
    await f.choose("other");
    await submit(f.host, "Save this next choice");
    await vi.waitFor(() =>
      expect(f.entries[PALETTE_PREFERENCE_KEY]).toMatchObject({ agentId: "other" }),
    );
  });

  it("keeps unsent selections through same-user reconnect but not account replacement", async () => {
    const f = await mountPreferences();
    await f.choose("other");
    await f.reconnect();
    await f.host.updateComplete;
    expect(f.select().value).toBe("other");
    const hello = expectDefined(f.context.gateway.snapshot.hello, "Gateway hello");
    f.context.gateway.snapshot.hello = {
      ...hello,
      auth: { ...expectDefined(hello.auth, "auth"), recoveryScope: "principal-b" },
    };
    Object.assign(f.context.gateway.snapshot, { selfUser: { id: "bob" } });
    Object.assign(f.context.gateway.snapshot.client!, { recoveryScope: "principal-b" });
    f.publish();
    await vi.waitFor(() => expect(f.select().value).toBe("main"));
    expect(f.writes).toEqual([]);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    "leaves workspace-search composition keys untouched: %j",
    async (composition) => {
      const { host } = await mountPreferences();
      setting(host, "trigger")!.click();
      await host.updateComplete;
      const search = expectDefined(
        host.querySelector<HTMLInputElement>(".palette-session-settings__search"),
        "workspace search",
      );
      search.focus();
      for (const key of ["Escape", "ArrowDown", "ArrowUp"]) {
        const event = new KeyboardEvent("keydown", {
          key,
          ...composition,
          bubbles: true,
          cancelable: true,
        });
        search.dispatchEvent(event);
        await host.updateComplete;
        expect(event.defaultPrevented).toBe(false);
        expect(setting(host, "search")).toBe(search);
        expect(document.activeElement).toBe(search);
      }
    },
  );
});
