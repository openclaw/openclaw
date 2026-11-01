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
    expect(host.draft.submitting).toBe(true);
    expect(host.draft.error).toBeNull();
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

  it("omits the worktree setting for a non-Git workspace", async () => {
    const { host } = await mount();
    await vi.waitFor(() => expect(setting(host, "workspace")).not.toBeNull());
    expect(host.querySelector('[role="switch"][aria-label="New worktree"]')).toBeNull();
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

    setting(host, "trigger")!.click();
    await waitForSolid(() =>
      expect(host.querySelector(".palette-session-settings")?.matches(":popover-open")).toBe(true),
    );
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
      await vi.waitFor(() => expect(setting(host, "workspace")).not.toBeNull());
      expectDefined(setting(host, "workspace"), "workspace picker").click();
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
    expect(setting(host, "workspace")?.textContent).toContain("Hosted workspace");
    expect(setting(host, "workspace")?.textContent).toContain("OpenAI (Agents API)");
    expect(setting(host, "worktree")).toBeNull();
    await select("local", "registered");
    expect(setting(host, "workspace")?.textContent).toContain("Local project");
    expect(setting(host, "workspace")?.textContent).not.toContain("Agents API");
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

  it.each(["unchanged", "connection", "account"] as const)(
    "settles one locked creation when its owner is %s",
    async (change) => {
      const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
      const { host, context, create, publish } = await mount();
      const accepted = createDeferred<SessionCreateOutcome>();
      create.mockReturnValueOnce(accepted.promise);
      host.draft.setMessage("Hold my creation");
      await vi.waitFor(() => expect(host.draft.canSubmit).toBe(true));
      const submission = host.draft.submit();
      await vi.waitFor(() => expect(host.draft.submitting).toBe(true));
      try {
        if (change === "unchanged") {
          await host.draft.submit();
          host.paletteOpen = false;
          host.draft.close();
          host.paletteOpen = true;
          host.draft.open();
          expect(host.draft).toMatchObject({ message: "Hold my creation", submitting: true });
          host.draft.setMessage("must not replace the submitted intent");
          expect(host.draft.message).toBe("Hold my creation");
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
          host.draft.open();
          expect(host.draft.message).toBe("");
        }
      } finally {
        accepted.resolve({ key: "agent:main:dashboard:held", initialRun: { status: "idle" } });
        await submission;
      }
      expect(create).toHaveBeenCalledOnce();
      expect(host.started).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0);
      expect(context.navigateAndWait).not.toHaveBeenCalled();
      if (change !== "unchanged") {
        expect(showToast).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["same-owner", "gateway-object", "disconnected"])(
    "keeps rejected-session recovery bound to its owner after %s reconnect",
    async (reconnect) => {
      const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
      const { host, context, create, publish } = await mount();
      create.mockResolvedValue({
        key: "agent:main:dashboard:rejected",
        initialRun: { status: "rejected", error: "Initial turn rejected" },
      });
      await submit(host, "Keep the rejected task recoverable");
      const open = showToast.mock.calls.at(-1)?.[0].onAction;
      expect(open).toBeTypeOf("function");
      context.gateway.snapshot.phase = "reconnecting";
      publish();
      context.gateway.snapshot.client = createDraftFixture().context.gateway.snapshot.client;
      context.gateway.snapshot.phase = reconnect === "disconnected" ? "reconnecting" : "connected";
      if (reconnect === "gateway-object") {
        Object.assign(context, { gateway: { ...context.gateway } });
      }
      publish();
      await host.updateComplete;
      if (reconnect === "same-owner") {
        expect(host.draft).toMatchObject({
          message: "Keep the rejected task recoverable",
          canSubmit: false,
        });
        const recovery = [...host.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Open session",
        );
        expect(recovery).toBeDefined();
        recovery?.click();
        expect(context.gateway.setSessionKey).toHaveBeenCalledWith("agent:main:dashboard:rejected");
        expect(context.navigate).toHaveBeenCalledOnce();
        expect(host.started).toHaveBeenCalledOnce();
      } else {
        open?.();
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
  const remember = () =>
    expectDefined(
      host.querySelector<HTMLInputElement>(".palette-session-settings__remember input"),
      "remember",
    );
  const footer = () => expectDefined(setting(host, "footer"), "preference status");
  const select = () => agent(host);
  const worktree = () =>
    expectDefined(host.querySelector<HTMLButtonElement>('[role="switch"]'), "worktree");
  // Wait out cold preference imports, then flush their queued presentation updates.
  await fixture.host.settingsReady.promise;
  await waitForSolid(() => {
    expect(remember().disabled).toBe(false);
    expect(worktree().disabled).toBe(false);
  });
  return {
    ...fixture,
    entries,
    writes,
    remember,
    footer,
    select,
    worktree,
    choose: async (id: string) => {
      select().onSelect(id);
      await host.updateComplete;
    },
    busy: async (value: boolean) => {
      await vi.waitFor(() => {
        expect(footer().getAttribute("aria-busy")).toBe(String(value));
        expect(remember().disabled).toBe(false);
      });
    },
    error: () => host.querySelector('.palette-session-settings__error[role="alert"]'),
    retry: () => expectDefined(setting(host, "error button"), "retry").click(),
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

describe("palette-only remembered settings", () => {
  it("never borrows or consumes the foreground draft's one-use worktree name", async () => {
    const ordinary = { folder: "/workspace", worktree: true, worktreeName: "foreground-task" };
    const fixture = await mountPreferences({
      "new-session.v1:main": ordinary,
      [PALETTE_PREFERENCE_KEY]: {
        agentId: "main",
        selection: { folder: "/workspace", worktree: true, worktreeName: "old-palette-name" },
      },
    });
    await vi.waitFor(() => expect(fixture.place.worktreeName).toBe("foreground-task"));
    await submit(fixture.host, "A separate background worktree task");
    const params = fixture.create.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      worktree: true,
      message: "A separate background worktree task",
    });
    expect(params).not.toHaveProperty("worktreeName");
    expect(fixture.place.worktreeName).toBe("foreground-task");
    expect(fixture.entries["new-session.v1:main"]).toEqual(ordinary);
    expect(fixture.writes).toEqual([]);
  });

  it.each([false, true])(
    "refreshes confirmed remount settings without overriding edited choices (edited=%s)",
    async (edited) => {
      const fixture = await mountPreferences();
      const { saving, release } = holdPaletteSave(fixture);
      await fixture.choose("main");
      fixture.remember().click();
      let replacement: PaletteDraftHost | undefined;
      try {
        await saving;
        await fixture.busy(true);
        await fixture.choose("other");
        fixture.host.remove();
        replacement = new PaletteDraftHost(fixture.context);
        replacement.draft.open();
        const current = replacement;
        await vi.waitFor(() =>
          expect(
            current.querySelector<HTMLInputElement>(".palette-session-settings__remember input")
              ?.disabled,
          ).toBe(false),
        );
        expect(setting(current, "footer")?.getAttribute("aria-busy")).toBe("false");
        if (edited) {
          const select = agent(current);
          select.onSelect("other");
          await current.updateComplete;
          select.onSelect("main");
          await current.updateComplete;
        }
        release();
        await vi.waitFor(() =>
          expect(fixture.entries[PALETTE_PREFERENCE_KEY]).toMatchObject({ agentId: "other" }),
        );
        await vi.waitFor(() =>
          expect(
            current.querySelector<HTMLInputElement>(".palette-session-settings__remember input")
              ?.checked,
          ).toBe(!edited),
        );
        expect(agent(current).value).toBe(edited ? "main" : "other");
      } finally {
        release();
        replacement?.remove();
      }
    },
  );

  it.each(["selection", "deletion"] as const)(
    "surfaces an unconfirmed queued %s after reconnect and retries the latest intent",
    async (intent) => {
      const fixture = await mountPreferences();
      const { saving, release } = holdPaletteSave(fixture);
      const checkPrompt = await preservePrompt(fixture.host);
      await fixture.choose("other");
      fixture.remember().click();
      try {
        await saving;
        await fixture.busy(true);
        if (intent === "selection") {
          fixture.select().onSelect("main");
        } else {
          fixture.remember().click();
        }
        await fixture.host.updateComplete;
        await fixture.reconnect();
        await fixture.busy(false);
        expect(fixture.error()).not.toBeNull();
        expect(fixture.remember().checked).toBe(false);
        expect(fixture.select().value).toBe("main");
        checkPrompt();
        release();
        await vi.waitFor(() =>
          expect(fixture.entries[PALETTE_PREFERENCE_KEY]).toMatchObject({ agentId: "other" }),
        );
        const retry = holdPaletteSave(fixture);
        fixture.retry();
        try {
          await retry.saving;
          await fixture.busy(true);
        } finally {
          retry.release();
        }
        await vi.waitFor(() => {
          if (intent === "selection") {
            expect(fixture.entries[PALETTE_PREFERENCE_KEY]).toMatchObject({ agentId: "main" });
          } else {
            expect(fixture.entries[PALETTE_PREFERENCE_KEY]).toBeUndefined();
          }
          expect(fixture.error()).toBeNull();
        });
        expect(fixture.remember().checked).toBe(intent === "selection");
        expect(fixture.footer().getAttribute("aria-busy")).toBe("false");
      } finally {
        release();
      }
    },
  );

  it("remembers only opted-in palette settings and restores defaults without touching prompt/caret", async () => {
    const ordinary = { folder: "/workspace", worktree: true };
    const fixture = await mountPreferences({ "new-session.v1:main": ordinary });
    const { host, entries, writes, select, remember, gateway, place } = fixture;
    await vi.waitFor(() => expect(fixture.worktree().getAttribute("aria-checked")).toBe("true"));
    await fixture.choose("other");
    expect(select().value).toBe("other");
    expect(writes).toEqual([]);
    reopen(host);
    await vi.waitFor(() => expect(select().value).toBe("main"));
    expect(entries["new-session.v1:main"]).toEqual(ordinary);
    expect(entries[PALETTE_PREFERENCE_KEY]).toBeUndefined();
    await fixture.choose("other");
    remember().click();
    await vi.waitFor(() =>
      expect(entries[PALETTE_PREFERENCE_KEY]).toMatchObject({
        agentId: "other",
        selection: { folder: "/other" },
      }),
    );
    expect(Object.keys(writes[0] ?? {})).toEqual([PALETTE_PREFERENCE_KEY]);
    reopen(host);
    await vi.waitFor(() => expect(select().value).toBe("other"));
    expect(remember().checked).toBe(true);
    // The concurrently mounted full-page owner keeps writing only its ordinary key.
    place.applyFolder("/updated-default");
    await vi.waitFor(() => expect(gateway.readPreference("main")?.folder).toBe("/updated-default"));
    expect(entries[PALETTE_PREFERENCE_KEY]).toMatchObject({ agentId: "other" });
    const checkPrompt = await preservePrompt(host);
    remember().click();
    await host.updateComplete;
    expect(select().value).toBe("main");
    expect(setting(host, "workspace")?.textContent).toContain("updated-default");
    checkPrompt();
    await vi.waitFor(() => expect(entries[PALETTE_PREFERENCE_KEY]).toBeUndefined());
    expect(entries["new-session.v1:main"]).toMatchObject({ folder: "/updated-default" });
    expect(writes.at(-1)).toEqual({ [PALETTE_PREFERENCE_KEY]: null });
  });

  it.each([false, true])("retries failed preference writes (deletion=%s)", async (deleting) => {
    const saved = { agentId: "other", selection: { folder: "/other", worktree: false } };
    const fixture = await mountPreferences(deleting ? { [PALETTE_PREFERENCE_KEY]: saved } : {});
    const { host, entries, remember, select, setReject } = fixture;
    if (deleting) {
      await vi.waitFor(() => expect(select().value).toBe("other"));
      host.draft.setMessage("Keep this task");
    } else {
      select().onSelect("other");
    }
    setReject(true);
    remember().click();
    await host.updateComplete;
    if (deleting) {
      expect(select().value).toBe("main");
      expect(host.draft.message).toBe("Keep this task");
    }
    await vi.waitFor(() => expect(fixture.error()).not.toBeNull());
    if (deleting) {
      expect(entries[PALETTE_PREFERENCE_KEY]).toMatchObject({ agentId: "other" });
    } else {
      expect(entries[PALETTE_PREFERENCE_KEY]).toBeUndefined();
    }
    expect(remember().checked).toBe(false);
    expect(select().value).toBe(deleting ? "main" : "other");
    if (!deleting) {
      reopen(host);
      await host.updateComplete;
      expect(fixture.error()).not.toBeNull();
    }
    setReject(false);
    const retry = holdPaletteSave(fixture);
    fixture.retry();
    try {
      await retry.saving;
      await fixture.busy(true);
      reopen(host);
      await fixture.busy(false);
      expect(select().value).toBe(deleting ? "main" : "other");
      expect(host.draft.message).toBe("");
    } finally {
      retry.release();
    }
    await vi.waitFor(() => {
      if (deleting) {
        expect(entries[PALETTE_PREFERENCE_KEY]).toBeUndefined();
      } else {
        expect(entries[PALETTE_PREFERENCE_KEY]).toMatchObject({ agentId: "other" });
      }
    });
    if (deleting) {
      expect(select().value).toBe("main");
    } else {
      await vi.waitFor(() => expect(remember().checked).toBe(true));
    }
  });

  it("keeps local selections through same-user reconnect but never adopts another owner's override", async () => {
    const fixture = await mountPreferences({
      [PALETTE_PREFERENCE_KEY]: {
        agentId: "other",
        selection: { folder: "/other", worktree: false },
      },
    });
    const { context, publish, entries, select, remember } = fixture;
    await vi.waitFor(() => expect(select().value).toBe("other"));
    remember().click();
    await vi.waitFor(() => expect(entries[PALETTE_PREFERENCE_KEY]).toBeUndefined());
    select().onSelect("other");
    await fixture.reconnect();
    await vi.waitFor(() => expect(remember().disabled).toBe(false));
    expect(select().value).toBe("other");
    const hello = expectDefined(context.gateway.snapshot.hello, "Gateway hello");
    context.gateway.snapshot.hello = {
      ...hello,
      auth: {
        ...expectDefined(hello.auth, "Gateway authentication"),
        recoveryScope: "principal-b",
      },
    };
    Object.assign(context.gateway.snapshot, { selfUser: { id: "bob" } });
    Object.assign(context.gateway.snapshot.client!, { recoveryScope: "principal-b" });
    publish();
    await vi.waitFor(() => expect(select().value).toBe("main"));
    expect(remember().checked).toBe(false);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    "leaves workspace-search composition keys untouched: %j",
    async (composition) => {
      const { host } = await mountPreferences();
      setting(host, "trigger")!.click();
      expectDefined(setting(host, "workspace"), "workspace picker").click();
      await host.updateComplete;
      expectDefined(
        host.querySelector<HTMLButtonElement>(".header-search__toggle"),
        "workspace search toggle",
      ).click();
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
