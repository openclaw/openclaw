/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { AgentSelectElement } from "../../components/agent-select.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { writeSessionPlacementRecovery } from "../../lib/sessions/session-placement-recovery.ts";
import * as toast from "../../lib/toast.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { mount, PaletteDraftHost } from "../../test-helpers/palette-session-draft.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { NewSessionDraftPersistence } from "./draft-persistence.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { PALETTE_PREFERENCE_KEY, PREFS_MIGRATION_KEY } from "./preferences.ts";

const ORDINARY_KEY = "new-session.v1:main";
const task = "Palette task";
const remembered = (agentId = "other") => ({
  agentId,
  selection: { folder: agentId === "main" ? "/workspace" : "/other", worktree: false },
});
const agents = (workspaceGit = false) =>
  ["main", "other"].map((id) => ({
    id,
    workspace: id === "main" ? "/workspace" : "/other",
    workspaceGit,
    model: { primary: `example/${id}` },
  }));

function required<T extends HTMLElement = HTMLElement>(
  host: Pick<ParentNode, "querySelector">,
  selector: string,
) {
  return expectDefined(host.querySelector<T>(selector), selector);
}
function setting<T extends HTMLElement = HTMLElement>(
  host: Pick<ParentNode, "querySelector">,
  suffix: string,
) {
  return host.querySelector<T>(`.palette-session-settings${suffix}`);
}
function control<T extends HTMLElement = HTMLButtonElement>(
  host: PaletteDraftHost,
  suffix: string,
) {
  return expectDefined(setting<T>(host, `__${suffix}`), suffix);
}
const agentSelect = (host: PaletteDraftHost) =>
  required<AgentSelectElement>(host, "openclaw-agent-select");
async function choose(host: PaletteDraftHost, agentId: string) {
  agentSelect(host).onSelect(agentId);
  await host.updateComplete;
}
function changeOwner(context: Awaited<ReturnType<typeof mount>>["context"], user?: string) {
  const { snapshot } = context.gateway;
  const hello = expectDefined(snapshot.hello, "Gateway hello");
  snapshot.hello = { ...hello, auth: { ...hello.auth!, recoveryScope: "principal-b" } };
  Object.assign(snapshot.client!, { recoveryScope: "principal-b" });
  if (user) {
    Object.assign(snapshot, { selfUser: { id: user } });
  }
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
    const { host, context } = await mount({
      methods: ["agents.list", "environments.list", "sessions.create", "sessions.send"],
      placementPolicy: () => policy.promise,
    });
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key: "agent:main:dashboard:cold-required",
      initialRun: { status: "idle" },
    });
    vi.mocked(context.placementStartup.start).mockImplementation(() => submitted.resolve());
    host.draft.setMessage("Carry my cold Send into the required worker");
    host.draft.adoptImageFiles([new File(["cold attachment"], "cold.txt", { type: "text/plain" })]);
    await host.updateComplete;
    expect(host.querySelector('.chat-attachment-loading[data-state="reading"]')).not.toBeNull();
    await waitForSolid(() => {
      expect(host.querySelector('.chat-attachment-loading[data-state="ready"]')).not.toBeNull();
    });
    host.observeColdSubmission = true;
    host.draft.submitCold();
    await host.updateComplete;
    expect(host.draft.messageLocked).toBe(true);
    expect(context.sessions.createResult).not.toHaveBeenCalled();
    policy.resolve({ sessionPlacement: { requiredProfile: profile } });
    await context.agents.refreshList();
    host.requestUpdate();
    await host.coldOutcome.promise;
    expect(host.draft).toMatchObject({ submitting: true, error: null });
    await submitted.promise;
    expect(context.sessions.createResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "", worktree: true, worktreeSource: "empty" }),
      { reconciliation: "background" },
    );
    expect(context.placementStartup.start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        recovery: expect.objectContaining({
          message: "Carry my cold Send into the required worker",
          target: { kind: "profile", profileId: profile.id, required: true },
          attachments: [expect.objectContaining({ fileName: "cold.txt", mimeType: "text/plain" })],
        }),
      }),
    );
  });

  it("omits the worktree setting for a non-Git workspace", async () => {
    const { host } = await mount();
    await vi.waitFor(() => expect(setting(host, "__workspace")).not.toBeNull());
    expect(host.querySelector('[role="switch"][aria-label="New worktree"]')).toBeNull();
  });

  it("loads identities for every open agent-menu row and only the selection after closing", async () => {
    const { host, context } = await mount({ agents: agents() });
    const picker = required<AgentSelectElement>(host, "openclaw-agent-select");
    await picker.updateComplete;
    for (const item of picker.querySelectorAll<HTMLElement>('[role="menuitemradio"]')) {
      item.scrollIntoView = vi.fn();
    }
    const trigger = required<HTMLButtonElement>(picker, ".agent-select__trigger");
    const menu = expectDefined(picker.querySelector(".agent-select__menu"), "agent menu");
    const ensure = vi.mocked(context.agentIdentity.ensure);
    await waitForSolid(() => expect(ensure).toHaveBeenLastCalledWith(["main"]));

    setting<HTMLButtonElement>(host, "__trigger")!.click();
    await waitForSolid(() => expect(setting(host, "")?.matches(":popover-open")).toBe(true));
    ensure.mockClear();
    trigger.click();
    await waitForSolid(() => {
      expect(menu.matches(":popover-open")).toBe(true);
      expect(ensure).toHaveBeenLastCalledWith(["main", "other"]);
    });

    ensure.mockClear();
    trigger.click();
    await waitForSolid(() => {
      expect(menu.matches(":popover-open")).toBe(false);
      expect(ensure).toHaveBeenLastCalledWith(["main"]);
    });
  });

  it("selects a hosted workspace in palette settings without cloning or dispatching a project", async () => {
    const hosted = {
      id: "agentsapi",
      source: "model",
      workspaceEnvironment: { kind: "provider-hosted", label: "OpenAI (Agents API)" },
    };
    const model = {
      id: "gpt-5.6-luna",
      name: "Luna",
      provider: "openai",
      available: true,
      agentRuntime: { id: "openclaw", source: "model" },
      runtimeChoices: [{ agentRuntime: hosted, available: true }],
    };
    const { host, context, request } = await mount({
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
      await vi.waitFor(() => expect(setting(host, "__workspace")).not.toBeNull());
      control(host, "workspace").click();
      await host.updateComplete;
      const selector = `[data-machine="${machine}"][data-project="${project}"]`;
      await vi.waitFor(() => expect(host.querySelector(selector)).not.toBeNull());
      required<HTMLButtonElement>(host, selector).click();
      await host.updateComplete;
    };

    await select("local", "registered");
    await select("runtime:agentsapi");
    expect(setting(host, "__workspace")?.textContent).toContain("Hosted workspace");
    expect(setting(host, "__workspace")?.textContent).toContain("OpenAI (Agents API)");
    expect(setting(host, "__worktree")).toBeNull();
    await select("local", "registered");
    expect(setting(host, "__workspace")?.textContent).toContain("Local project");
    expect(setting(host, "__workspace")?.textContent).not.toContain("Agents API");
    await select("runtime:agentsapi");
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key: "agent:main:hosted-palette",
      initialRun: { status: "idle" },
    });
    await submit(host, "Analyze my attachment");
    const payload = vi.mocked(context.sessions.createResult).mock.calls[0]?.[0];
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
      const { host, context, publish } = await mount();
      const accepted = createDeferred<SessionCreateOutcome>();
      vi.mocked(context.sessions.createResult).mockReturnValueOnce(accepted.promise);
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
            changeOwner(context, "another-user");
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
      expect(context.sessions.createResult).toHaveBeenCalledOnce();
      expect(host.started).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0);
      expect(context.navigateAndWait).not.toHaveBeenCalled();
      if (change !== "unchanged") {
        expect(showToast).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["idle", "started", "rejected", "same-owner", "gateway-object", "disconnected"] as const)(
    "reports background creation and owner-bound recovery: %s",
    async (outcome) => {
      const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
      const { host, context, publish } = await mount({ agents: agents() });
      await choose(host, "other");
      const initialRun =
        outcome === "idle" || outcome === "started"
          ? { status: outcome }
          : { status: "rejected" as const, error: "First message rejected" };
      vi.mocked(context.sessions.createResult).mockResolvedValue({
        key: "agent:other:dashboard:created",
        initialRun,
      });
      await submit(host, task);
      expect(context.sessions.createResult).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "other", message: task }),
        { reconciliation: "background" },
      );
      if (initialRun.status === "rejected") {
        expect(host.started).not.toHaveBeenCalled();
        expect(host.draft).toMatchObject({
          message: task,
          error: initialRun.error,
          canSubmit: false,
        });
        await host.draft.submit();
        expect(context.sessions.createResult).toHaveBeenCalledOnce();
        reopen(host);
        expect(host.draft.message).toBe(task);
      } else {
        expect(host.started).toHaveBeenCalledOnce();
        expect(host.draft.message).toBe("");
      }
      expect(context.navigateAndWait).not.toHaveBeenCalled();
      expect(context.agentSelection.set).not.toHaveBeenCalled();
      expect(context.gateway.setSessionKey).not.toHaveBeenCalled();
      const notice = showToast.mock.calls.at(-1)?.[0];
      expect(notice?.actionLabel).toBeTruthy();
      const reconnect = !["idle", "started", "rejected"].includes(outcome);
      if (reconnect) {
        expect(notice?.onAction).toBeTypeOf("function");
        context.gateway.snapshot.phase = "reconnecting";
        publish();
        context.gateway.snapshot.client = createDraftFixture().context.gateway.snapshot.client;
        context.gateway.snapshot.phase = outcome === "disconnected" ? "reconnecting" : "connected";
        if (outcome === "gateway-object") {
          Object.assign(context, { gateway: { ...context.gateway } });
        }
        publish();
        await host.updateComplete;
      }
      if (outcome === "same-owner") {
        expect(host.draft).toMatchObject({ message: task, canSubmit: false });
        const recovery = [...host.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Open session",
        );
        expect(recovery).toBeDefined();
        recovery?.click();
        expect(host.started).toHaveBeenCalledOnce();
      } else {
        notice?.onAction?.();
      }
      if (outcome === "gateway-object" || outcome === "disconnected") {
        expect(context.navigate).not.toHaveBeenCalled();
        expect(context.gateway.setSessionKey).not.toHaveBeenCalled();
      } else {
        expect(context.gateway.setSessionKey).toHaveBeenCalledWith("agent:other:dashboard:created");
        expect(context.navigate).toHaveBeenCalledOnce();
      }
      expect(context.sessions.createResult).toHaveBeenCalledOnce();
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
    const settingsTrigger = setting(host, "__trigger");
    expect(settingsTrigger?.id).toMatch(/^palette-session-\d+-settings-trigger$/);
    expect(settingsTrigger?.getAttribute("aria-controls")).toBe(
      host.querySelector(".oc-popover.palette-session-settings")?.id,
    );
  });

  it("clears another credential owner's text and keeps a failed create unaccepted", async () => {
    const { host, context, publish } = await mount();
    vi.mocked(context.sessions.createResult).mockResolvedValue(null);
    Object.assign(context.sessions.state, { error: "Creation denied" });
    await submit(host, task);
    expect(host.started).not.toHaveBeenCalled();
    expect(host.draft).toMatchObject({
      message: task,
      error: "Creation denied",
    });
    changeOwner(context);
    publish();
    expect(host.draft.message).toBe("");
  });
});

async function mountPreferences(initial: Record<string, unknown> = {}) {
  const entries: Record<string, unknown> = { [PREFS_MIGRATION_KEY]: true, ...initial };
  const writes: Record<string, unknown>[] = [];
  const save = { reject: false, before: async (_patch: Record<string, unknown>) => {} };
  const f = await mount({
    selfUser: { id: "alice" },
    agents: agents(true),
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
        if (save.reject) {
          throw new Error("Preference save failed");
        }
        await save.before(params.entries);
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
  const { host, context, publish } = f;
  const remember = () => control<HTMLInputElement>(host, "remember input");
  const select = () => agentSelect(host);
  const worktree = () => required<HTMLButtonElement>(host, '[role="switch"]');
  const error = () => setting(host, '__error[role="alert"]');
  const expectSaved = (agentId?: string) => {
    if (agentId) {
      expect(entries[PALETTE_PREFERENCE_KEY]).toMatchObject({ agentId });
    } else {
      expect(entries[PALETTE_PREFERENCE_KEY]).toBeUndefined();
    }
  };
  await host.settingsReady.promise;
  await waitForSolid(() => {
    expect(remember().disabled).toBe(false);
    expect(worktree().disabled).toBe(false);
  });
  return {
    ...f,
    entries,
    writes,
    save,
    remember,
    select,
    worktree,
    expectSaved,
    saved: (agentId?: string) => vi.waitFor(() => expectSaved(agentId)),
    error,
    retry: () => control(host, "error button").click(),
    choose: (agentId: string) => choose(host, agentId),
    prompt: async (message: string) => {
      host.draft.setMessage(message);
      await host.updateComplete;
      const input = required<HTMLTextAreaElement>(host, "textarea");
      input.focus();
      input.setSelectionRange(5, 9);
      return input;
    },
    reconnect: async () => {
      context.gateway.snapshot.phase = "reconnecting";
      publish();
      await host.updateComplete;
      context.gateway.snapshot.phase = "connected";
      context.gateway.snapshot.hello = {
        ...expectDefined(context.gateway.snapshot.hello, "Gateway hello"),
      };
      publish();
      await host.updateComplete;
      await vi.waitFor(() => expect(remember().disabled).toBe(false));
    },
  };
}

function holdSave(f: Awaited<ReturnType<typeof mountPreferences>>, key = PALETTE_PREFERENCE_KEY) {
  const saving = createDeferred();
  const held = createDeferred();
  let heldOnce = false;
  f.save.before = async (patch) => {
    if (Object.hasOwn(patch, key) && !heldOnce) {
      heldOnce = true;
      saving.resolve();
      await held.promise;
    }
  };
  return { saving: saving.promise, release: held.resolve };
}

describe("palette-only remembered settings", () => {
  it("never borrows or consumes the foreground draft's one-use worktree name", async () => {
    const ordinary = { folder: "/workspace", worktree: true, worktreeName: "foreground-task" };
    const f = await mountPreferences({
      [ORDINARY_KEY]: ordinary,
      [PALETTE_PREFERENCE_KEY]: {
        agentId: "main",
        selection: { folder: "/workspace", worktree: true, worktreeName: "old-palette-name" },
      },
    });
    await vi.waitFor(() => expect(f.place.worktreeName).toBe("foreground-task"));
    await submit(f.host, task);
    const params = vi.mocked(f.context.sessions.createResult).mock.calls[0]?.[0];
    expect(params).toMatchObject({ worktree: true, message: task });
    expect(params).not.toHaveProperty("worktreeName");
    expect(f.place.worktreeName).toBe("foreground-task");
    expect(f.entries[ORDINARY_KEY]).toEqual(ordinary);
    expect(f.writes).toEqual([]);
  });

  it("uses a confirmed ordinary default after its initiating surface is disposed", async () => {
    const f = await mountPreferences();
    const { saving, release } = holdSave(f, ORDINARY_KEY);
    f.place.applyFolder("/confirmed");
    try {
      await saving;
      f.gateway.disconnect();
      release();
      await vi.waitFor(() =>
        expect(f.entries[ORDINARY_KEY]).toMatchObject({ folder: "/confirmed" }),
      );
      reopen(f.host);
      await f.host.updateComplete;
      expect(setting(f.host, "__workspace")?.textContent).toContain("confirmed");
    } finally {
      release();
    }
  });

  it.each([false, true])(
    "refreshes confirmed remount settings without overriding edited choices (edited=%s)",
    async (edited) => {
      const f = await mountPreferences();
      const { saving, release } = holdSave(f);
      await f.choose("main");
      f.remember().click();
      let replacement: PaletteDraftHost | undefined;
      try {
        await saving;
        await f.choose("other");
        f.host.remove();
        replacement = new PaletteDraftHost(f.context);
        replacement.draft.open();
        const current = replacement;
        await vi.waitFor(() =>
          expect(setting<HTMLInputElement>(current, "__remember input")?.disabled).toBe(false),
        );
        if (edited) {
          await choose(current, "other");
          await choose(current, "main");
        }
        release();
        await f.saved("other");
        expect(f.writes).toHaveLength(2);
        await vi.waitFor(() =>
          expect(setting<HTMLInputElement>(current, "__remember input")?.checked).toBe(!edited),
        );
        expect(agentSelect(current).value).toBe(edited ? "main" : "other");
      } finally {
        release();
        replacement?.remove();
      }
    },
  );

  it.each(["selection", "deletion"] as const)(
    "surfaces an unconfirmed queued %s after reconnect and retries the latest intent",
    async (intent) => {
      const f = await mountPreferences();
      const { saving, release } = holdSave(f);
      const prompt = await f.prompt(task);
      await f.choose("other");
      f.remember().click();
      try {
        await saving;
        await f.host.updateComplete;
        if (intent === "selection") {
          f.select().onSelect("main");
        } else {
          f.remember().click();
        }
        await f.host.updateComplete;
        await f.reconnect();
        expect(f.error()).not.toBeNull();
        expect(f.remember()).toMatchObject({ checked: false });
        expect(f.select()).toMatchObject({ value: "main" });
        expect(f.host.draft.message).toBe(task);
        expect([prompt.selectionStart, prompt.selectionEnd]).toEqual([5, 9]);
        release();
        await f.saved("other");
        f.retry();
        await vi.waitFor(() => {
          f.expectSaved(intent === "selection" ? "main" : undefined);
          expect(f.error()).toBeNull();
        });
        expect(f.remember().checked).toBe(intent === "selection");
      } finally {
        release();
      }
    },
  );

  it("keeps one-off choices out of normal defaults and resets on reopen", async () => {
    const ordinary = { folder: "/workspace", worktree: true };
    const f = await mountPreferences({ [ORDINARY_KEY]: ordinary });
    await vi.waitFor(() => expect(f.worktree().getAttribute("aria-checked")).toBe("true"));
    await f.choose("other");
    expect(f.select().value).toBe("other");
    expect(f.writes).toEqual([]);
    reopen(f.host);
    await vi.waitFor(() => expect(f.select().value).toBe("main"));
    expect(f.entries[ORDINARY_KEY]).toEqual(ordinary);
    f.expectSaved();
  });

  it("remembers only the palette and restores defaults without touching prompt/caret", async () => {
    const f = await mountPreferences();
    await f.choose("other");
    f.remember().click();
    await f.saved("other");
    expect(f.entries[PALETTE_PREFERENCE_KEY]).toMatchObject({ selection: { folder: "/other" } });
    expect(Object.keys(f.writes[0] ?? {})).toEqual([PALETTE_PREFERENCE_KEY]);
    reopen(f.host);
    await vi.waitFor(() => expect(f.select().value).toBe("other"));
    expect(f.remember().checked).toBe(true);
    f.place.applyFolder("/updated-default");
    await vi.waitFor(() =>
      expect(f.gateway.readPreference("main")?.folder).toBe("/updated-default"),
    );
    f.expectSaved("other");
    const prompt = await f.prompt(task);
    f.remember().click();
    await f.host.updateComplete;
    expect(f.select().value).toBe("main");
    expect(setting(f.host, "__workspace")?.textContent).toContain("updated-default");
    expect(f.host.draft.message).toBe(task);
    expect(f.host.querySelector("textarea")).toBe(prompt);
    expect([prompt.selectionStart, prompt.selectionEnd]).toEqual([5, 9]);
    await f.saved();
    expect(f.entries[ORDINARY_KEY]).toMatchObject({ folder: "/updated-default" });
    expect(f.writes.at(-1)).toEqual({ [PALETTE_PREFERENCE_KEY]: null });
  });

  it.each([false, true])("retries failed preference writes (deletion=%s)", async (deleting) => {
    const f = await mountPreferences(deleting ? { [PALETTE_PREFERENCE_KEY]: remembered() } : {});
    if (deleting) {
      await vi.waitFor(() => expect(f.select().value).toBe("other"));
      f.host.draft.setMessage(task);
    } else {
      f.select().onSelect("other");
    }
    f.save.reject = true;
    f.remember().click();
    await f.host.updateComplete;
    if (deleting) {
      expect(f.select().value).toBe("main");
      expect(f.host.draft.message).toBe(task);
    }
    await vi.waitFor(() => expect(f.error()).not.toBeNull());
    f.expectSaved(deleting ? "other" : undefined);
    expect(f.remember().checked).toBe(false);
    expect(f.select().value).toBe(deleting ? "main" : "other");
    if (!deleting) {
      reopen(f.host);
      await f.host.updateComplete;
      expect(f.error()).not.toBeNull();
    }
    f.save.reject = false;
    f.retry();
    await f.saved(deleting ? undefined : "other");
    if (deleting) {
      expect(f.select().value).toBe("main");
    } else {
      await vi.waitFor(() => expect(f.remember().checked).toBe(true));
    }
  });

  it("keeps local choices on same-user reconnect but rejects another owner's override", async () => {
    const f = await mountPreferences({ [PALETTE_PREFERENCE_KEY]: remembered() });
    await vi.waitFor(() => expect(f.select().value).toBe("other"));
    f.remember().click();
    await f.saved();
    f.select().onSelect("other");
    await f.reconnect();
    expect(f.select().value).toBe("other");
    changeOwner(f.context, "bob");
    f.publish();
    await vi.waitFor(() => expect(f.select().value).toBe("main"));
    expect(f.remember().checked).toBe(false);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    "leaves workspace-search composition keys untouched: %j",
    async (composition) => {
      const { host } = await mountPreferences();
      control(host, "trigger").click();
      control(host, "workspace").click();
      await host.updateComplete;
      const search = control<HTMLInputElement>(host, "search");
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
        expect(setting(host, "__search")).toBe(search);
        expect(document.activeElement).toBe(search);
      }
    },
  );
});
