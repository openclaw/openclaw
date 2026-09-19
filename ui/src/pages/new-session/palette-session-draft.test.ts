/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { AgentSelect } from "../../components/agent-select.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { writeSessionPlacementRecovery } from "../../lib/sessions/session-placement-recovery.ts";
import * as toast from "../../lib/toast.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { NewSessionDraftPersistence } from "./draft-persistence.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { PaletteSessionDraft } from "./palette-session-draft.ts";
import { PALETTE_PREFERENCE_KEY, PREFS_MIGRATION_KEY } from "./preferences.ts";

class PaletteDraftHost extends OpenClawLightDomElement {
  context: ApplicationContext | undefined;
  paletteOpen = true;
  readonly started = vi.fn();
  readonly draft = new PaletteSessionDraft(
    this,
    () => ({ context: this.context, open: this.paletteOpen }),
    { onClose: () => this.started() },
  );
  override render() {
    return html`<textarea aria-label="Palette prompt" .value=${this.draft.message}></textarea
      >${this.draft.renderControls()}${this.draft.renderRecovery()}${this.draft.renderAuxiliary()}`;
  }
}
customElements.define("test-palette-session-draft", PaletteDraftHost);

async function mount(options: Parameters<typeof createDraftFixture>[0] = {}) {
  const fixture = createDraftFixture(options);
  const { context } = fixture;
  const listeners = new Set<() => void>();
  Object.assign(context.gateway, {
    connectionRevision: 1,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  Object.assign(context.agents, { subscribe: () => () => {} });
  Object.assign(context.agents.state, { connected: true, client: context.gateway.snapshot.client });
  Object.assign(context.sessions, { subscribe: () => () => {} });
  Object.assign(context.config, { subscribe: () => () => {} });
  Object.assign(context, {
    agentIdentity: {
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
      get: () => undefined,
    },
    navigate: vi.fn(),
  });
  Object.assign(context.placementStartup, { start: vi.fn() });
  const host = document.createElement("test-palette-session-draft") as PaletteDraftHost;
  host.context = context;
  document.body.append(host);
  host.draft.open();
  await host.updateComplete;
  await host.updateComplete;
  return { ...fixture, host, publish: () => listeners.forEach((listener) => listener()) };
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("PaletteSessionDraft", () => {
  it.each(["connection", "account"] as const)(
    "retires a locked prompt when the %s owner changes",
    async (change) => {
      const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
      const { host, context, publish } = await mount();
      let finish!: (value: SessionCreateOutcome) => void;
      vi.mocked(context.sessions.createResult).mockReturnValueOnce(
        new Promise<SessionCreateOutcome>((resolve) => {
          finish = resolve;
        }),
      );
      host.draft.setMessage("Private prompt for the original owner");
      await vi.waitFor(() => expect(host.draft.canSubmit).toBe(true));
      const submission = host.draft.submit();
      await vi.waitFor(() => expect(host.draft.submitting).toBe(true));
      try {
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
      } finally {
        finish({ key: "agent:main:dashboard:retired-owner", initialRun: { status: "idle" } });
        await submission;
      }
      expect(showToast).not.toHaveBeenCalled();
      expect(host.started).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: "idle" as const },
    { status: "started" as const },
    { status: "rejected" as const, error: "First message rejected" },
  ])(
    "reports accepted $status creation without changing the foreground selection",
    async (initialRun) => {
      const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
      const { host, context } = await mount({
        agents: [
          { id: "main", workspace: "/workspace", model: { primary: "example/main" } },
          { id: "other", workspace: "/other", model: { primary: "example/other" } },
        ],
      });
      const select = host.querySelector("openclaw-agent-select") as HTMLElement & {
        onSelect: (id: string) => void;
      };
      select.onSelect("other");
      host.draft.setMessage("Create with this explicit agent");
      vi.mocked(context.sessions.createResult).mockResolvedValue({
        key: "agent:other:dashboard:created",
        initialRun,
      });
      await vi.waitFor(() => expect(host.draft.canSubmit).toBe(true));
      await host.draft.submit();
      expect(context.sessions.createResult).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "other", message: "Create with this explicit agent" }),
        { reconciliation: "background" },
      );
      if (initialRun.status === "rejected") {
        expect(host.started).not.toHaveBeenCalled();
        expect(host.draft.message).toBe("Create with this explicit agent");
        expect(host.draft.error).toBe(initialRun.error);
        expect(host.draft.canSubmit).toBe(false);
        await host.draft.submit();
        expect(context.sessions.createResult).toHaveBeenCalledOnce();
        host.draft.close();
        host.draft.open();
        expect(host.draft.message).toBe("Create with this explicit agent");
      } else {
        expect(host.started).toHaveBeenCalledOnce();
        expect(host.draft.message).toBe("");
      }
      expect(context.navigateAndWait).not.toHaveBeenCalled();
      expect(context.agentSelection.set).not.toHaveBeenCalled();
      expect(context.gateway.setSessionKey).not.toHaveBeenCalled();
      const notice = showToast.mock.calls.at(-1)?.[0];
      expect(notice?.actionLabel).toBeTruthy();
      notice?.onAction?.();
      expect(context.gateway.setSessionKey).toHaveBeenCalledWith("agent:other:dashboard:created");
      expect(context.navigate).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "same-owner",
    "credentials-same-owner",
    "principal-change",
    "gateway-change",
    "gateway-object",
    "unscoped",
    "disconnected",
  ])("keeps rejected-session recovery bound to its owner after %s reconnect", async (reconnect) => {
    const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
    const { host, context, publish } = await mount();
    if (reconnect === "unscoped") {
      delete context.gateway.snapshot.hello!.auth!.recoveryScope;
      publish();
    }
    host.draft.setMessage("Keep the rejected task recoverable");
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key: "agent:main:dashboard:rejected",
      initialRun: { status: "rejected", error: "Initial turn rejected" },
    });
    await vi.waitFor(() => expect(host.draft.canSubmit).toBe(true));
    await host.draft.submit();
    const open = showToast.mock.calls.at(-1)?.[0].onAction;
    expect(open).toBeTypeOf("function");
    context.gateway.snapshot.phase = "reconnecting";
    publish();
    context.gateway.snapshot.client = createDraftFixture().context.gateway.snapshot.client;
    context.gateway.snapshot.phase = reconnect === "disconnected" ? "reconnecting" : "connected";
    // Transport reconnects replace the client without changing the credential revision.
    if (
      ["credentials-same-owner", "principal-change", "gateway-change", "gateway-object"].includes(
        reconnect,
      )
    ) {
      Object.assign(context.gateway, { connectionRevision: 2 });
    }
    if (reconnect === "principal-change") {
      const hello = context.gateway.snapshot.hello!;
      context.gateway.snapshot.hello = {
        ...hello,
        auth: { ...hello.auth!, recoveryScope: "principal-b" },
      };
      Object.assign(context.gateway.snapshot.client!, { recoveryScope: "principal-b" });
    } else if (reconnect === "gateway-object") {
      Object.assign(context, { gateway: { ...context.gateway } });
    } else if (reconnect === "gateway-change") {
      Object.assign(context.gateway.connection, { gatewayUrl: "ws://another.example" });
    }
    publish();
    await host.updateComplete;
    if (reconnect === "same-owner") {
      expect(host.draft.message).toBe("Keep the rejected task recoverable");
      expect(host.draft.canSubmit).toBe(false);
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
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
  });

  it("keeps one pending creation through close/reopen and suppresses duplicate submit", async () => {
    vi.spyOn(toast, "showToast").mockReturnValue(true);
    const { host, context } = await mount();
    let accept!: (result: SessionCreateOutcome) => void;
    vi.mocked(context.sessions.createResult).mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    host.draft.setMessage("Hold my creation");
    await vi.waitFor(() => expect(host.draft.canSubmit).toBe(true));
    const pending = host.draft.submit();
    await host.draft.submit();
    host.paletteOpen = false;
    host.draft.close();
    host.paletteOpen = true;
    host.draft.open();
    expect(host.draft.message).toBe("Hold my creation");
    expect(host.draft.submitting).toBe(true);
    host.draft.setMessage("must not replace the submitted intent");
    expect(host.draft.message).toBe("Hold my creation");
    accept({ key: "agent:main:dashboard:held", initialRun: { status: "idle" } });
    await pending;
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(host.started).toHaveBeenCalledOnce();
    expect(context.navigateAndWait).not.toHaveBeenCalled();
  });

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
    expect(host.querySelector("wa-popover.palette-session-settings")?.getAttribute("for")).toMatch(
      /^palette-session-\d+-settings-trigger$/,
    );
  });

  it("clears another credential owner's text and keeps a failed create unaccepted", async () => {
    const { host, context, publish } = await mount();
    host.draft.setMessage("Only for the first owner");
    vi.mocked(context.sessions.createResult).mockResolvedValue(null);
    Object.assign(context.sessions.state, { error: "Creation denied" });
    await vi.waitFor(() => expect(host.draft.canSubmit).toBe(true));
    await host.draft.submit();
    expect(host.started).not.toHaveBeenCalled();
    expect(host.draft.message).toBe("Only for the first owner");
    expect(host.draft.error).toBe("Creation denied");
    const hello = context.gateway.snapshot.hello!;
    context.gateway.snapshot.hello = {
      ...hello,
      auth: { ...hello.auth!, recoveryScope: "principal-b" },
    };
    Object.assign(context.gateway.snapshot.client!, { recoveryScope: "principal-b" });
    publish();
    expect(host.draft.message).toBe("");
  });
});

async function mountPreferences(initial: Record<string, unknown> = {}) {
  const entries: Record<string, unknown> = { [PREFS_MIGRATION_KEY]: true, ...initial };
  const writes: Record<string, unknown>[] = [];
  let reject = false;
  let beforeSave = async (_patch: Record<string, unknown>) => {};
  const fixture = await mount({
    selfUser: { id: "alice" },
    agents: [
      {
        id: "main",
        workspace: "/workspace",
        workspaceGit: true,
        model: { primary: "example/main" },
      },
      { id: "other", workspace: "/other", workspaceGit: true, model: { primary: "example/other" } },
    ],
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
  const remember = () =>
    expectDefined(
      fixture.host.querySelector<HTMLInputElement>(".palette-session-settings__remember input"),
      "palette remember checkbox",
    );
  const select = () =>
    expectDefined(
      fixture.host.querySelector<AgentSelect>("openclaw-agent-select"),
      "palette agent select",
    );
  const worktree = () =>
    expectDefined(
      fixture.host.querySelector<HTMLButtonElement>('[role="switch"]'),
      "palette worktree switch",
    );
  await vi.waitFor(() => expect(remember().disabled).toBe(false));
  await vi.waitFor(() => expect(worktree().disabled).toBe(false));
  return {
    ...fixture,
    entries,
    writes,
    remember,
    select,
    worktree,
    setReject: (value: boolean) => {
      reject = value;
    },
    setBeforeSave: (callback: (patch: Record<string, unknown>) => Promise<void>) => {
      beforeSave = callback;
    },
  };
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
    fixture.host.draft.setMessage("A separate background worktree task");
    await vi.waitFor(() => expect(fixture.host.draft.canSubmit).toBe(true));
    await fixture.host.draft.submit();
    const params = vi.mocked(fixture.context.sessions.createResult).mock.calls[0]?.[0];
    expect(params).toMatchObject({
      worktree: true,
      message: "A separate background worktree task",
    });
    expect(params).not.toHaveProperty("worktreeName");
    expect(fixture.place.worktreeName).toBe("foreground-task");
    expect(fixture.entries["new-session.v1:main"]).toEqual(ordinary);
    expect(fixture.writes).toEqual([]);
  });

  it("uses a confirmed ordinary default after its initiating surface is disposed", async () => {
    const fixture = await mountPreferences();
    let entered!: () => void;
    let release!: () => void;
    const saving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.setBeforeSave(async (patch) => {
      const preference = patch["new-session.v1:main"];
      if (isRecord(preference) && preference.folder === "/confirmed-after-disposal") {
        entered();
        await held;
      }
    });
    fixture.place.applyFolder("/confirmed-after-disposal");
    try {
      await saving;
      fixture.gateway.disconnect();
      release();
      await vi.waitFor(() =>
        expect(fixture.entries["new-session.v1:main"]).toMatchObject({
          folder: "/confirmed-after-disposal",
        }),
      );
      fixture.host.draft.close();
      fixture.host.draft.open();
      await fixture.host.updateComplete;
      expect(
        fixture.host.querySelector(".palette-session-settings__workspace")?.textContent,
      ).toContain("confirmed-after-disposal");
    } finally {
      release();
    }
  });

  it.each([false, true])(
    "refreshes confirmed remount settings without overriding edited choices (edited=%s)",
    async (edited) => {
      const fixture = await mountPreferences();
      let entered!: () => void;
      let release!: () => void;
      let heldOnce = false;
      const saving = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      fixture.setBeforeSave(async (patch) => {
        if (Object.hasOwn(patch, PALETTE_PREFERENCE_KEY) && !heldOnce) {
          heldOnce = true;
          entered();
          await held;
        }
      });
      fixture.select().onSelect("main");
      await fixture.host.updateComplete;
      fixture.remember().click();
      let replacement: PaletteDraftHost | undefined;
      try {
        await saving;
        fixture.select().onSelect("other");
        await fixture.host.updateComplete;
        fixture.host.remove();
        replacement = document.createElement("test-palette-session-draft") as PaletteDraftHost;
        replacement.context = fixture.context;
        document.body.append(replacement);
        replacement.draft.open();
        const current = replacement;
        await vi.waitFor(() =>
          expect(
            current.querySelector<HTMLInputElement>(".palette-session-settings__remember input")
              ?.disabled,
          ).toBe(false),
        );
        if (edited) {
          const select = expectDefined(
            current.querySelector<AgentSelect>("openclaw-agent-select"),
            "replacement agent",
          );
          select.onSelect("other");
          await current.updateComplete;
          select.onSelect("main");
          await current.updateComplete;
        }
        release();
        await vi.waitFor(() =>
          expect(fixture.entries[PALETTE_PREFERENCE_KEY]).toMatchObject({ agentId: "other" }),
        );
        expect(fixture.writes).toHaveLength(2);
        await vi.waitFor(() =>
          expect(
            current.querySelector<HTMLInputElement>(".palette-session-settings__remember input")
              ?.checked,
          ).toBe(!edited),
        );
        expect(current.querySelector<AgentSelect>("openclaw-agent-select")?.value).toBe(
          edited ? "main" : "other",
        );
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
      let entered!: () => void;
      let release!: () => void;
      let heldOnce = false;
      const saving = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      fixture.setBeforeSave(async (patch) => {
        if (Object.hasOwn(patch, PALETTE_PREFERENCE_KEY) && !heldOnce) {
          heldOnce = true;
          entered();
          await held;
        }
      });
      fixture.host.draft.setMessage("Keep this exact reconnect prompt");
      await fixture.host.updateComplete;
      const prompt = expectDefined(fixture.host.querySelector("textarea"), "palette prompt");
      prompt.focus();
      prompt.setSelectionRange(5, 9);
      fixture.select().onSelect("other");
      await fixture.host.updateComplete;
      fixture.remember().click();
      try {
        await saving;
        await fixture.host.updateComplete;
        if (intent === "selection") {
          fixture.select().onSelect("main");
        } else {
          fixture.remember().click();
        }
        await fixture.host.updateComplete;
        fixture.context.gateway.snapshot.phase = "reconnecting";
        fixture.publish();
        await fixture.host.updateComplete;
        fixture.context.gateway.snapshot.phase = "connected";
        fixture.context.gateway.snapshot.hello = {
          ...expectDefined(fixture.context.gateway.snapshot.hello, "Gateway hello"),
        };
        fixture.publish();
        await vi.waitFor(() => expect(fixture.remember().disabled).toBe(false));
        expect(
          fixture.host.querySelector('.palette-session-settings__error[role="alert"]'),
        ).not.toBeNull();
        expect(fixture.remember().checked).toBe(false);
        expect(fixture.select().value).toBe("main");
        expect(fixture.host.draft.message).toBe("Keep this exact reconnect prompt");
        expect([prompt.selectionStart, prompt.selectionEnd]).toEqual([5, 9]);
        release();
        await vi.waitFor(() =>
          expect(fixture.entries[PALETTE_PREFERENCE_KEY]).toMatchObject({ agentId: "other" }),
        );
        expectDefined(
          fixture.host.querySelector<HTMLButtonElement>(".palette-session-settings__error button"),
          "retry remembered settings",
        ).click();
        await vi.waitFor(() => {
          if (intent === "selection") {
            expect(fixture.entries[PALETTE_PREFERENCE_KEY]).toMatchObject({ agentId: "main" });
          } else {
            expect(fixture.entries[PALETTE_PREFERENCE_KEY]).toBeUndefined();
          }
          expect(
            fixture.host.querySelector('.palette-session-settings__error[role="alert"]'),
          ).toBeNull();
        });
        expect(fixture.remember().checked).toBe(intent === "selection");
      } finally {
        release();
      }
    },
  );

  it("keeps one-off choices out of normal defaults and resets on reopen", async () => {
    const { host, entries, writes, select, worktree } = await mountPreferences({
      "new-session.v1:main": { folder: "/workspace", worktree: true },
    });
    await vi.waitFor(() => expect(worktree().getAttribute("aria-checked")).toBe("true"));
    select().onSelect("other");
    await host.updateComplete;
    expect(select().value).toBe("other");
    expect(writes).toEqual([]);
    host.draft.close();
    host.draft.open();
    await vi.waitFor(() => expect(select().value).toBe("main"));
    expect(entries["new-session.v1:main"]).toEqual({ folder: "/workspace", worktree: true });
    expect(entries[PALETTE_PREFERENCE_KEY]).toBeUndefined();
  });

  it("remembers only the palette and disabling restores current defaults without touching prompt/caret", async () => {
    const { host, entries, writes, select, remember, gateway, place } = await mountPreferences();
    select().onSelect("other");
    await host.updateComplete;
    remember().click();
    await vi.waitFor(() =>
      expect(entries[PALETTE_PREFERENCE_KEY]).toMatchObject({
        agentId: "other",
        selection: { folder: "/other" },
      }),
    );
    expect(Object.keys(writes[0] ?? {})).toEqual([PALETTE_PREFERENCE_KEY]);
    host.draft.close();
    host.draft.open();
    await vi.waitFor(() => expect(select().value).toBe("other"));
    expect(remember().checked).toBe(true);
    // The concurrently mounted full-page owner keeps writing only its ordinary key.
    place.applyFolder("/updated-default");
    await vi.waitFor(() => expect(gateway.readPreference("main")?.folder).toBe("/updated-default"));
    expect(entries[PALETTE_PREFERENCE_KEY]).toMatchObject({ agentId: "other" });
    host.draft.setMessage("Keep this exact prompt");
    await host.updateComplete;
    const prompt = expectDefined(host.querySelector("textarea"), "palette prompt");
    prompt.focus();
    prompt.setSelectionRange(5, 9);
    remember().click();
    await host.updateComplete;
    expect(select().value).toBe("main");
    expect(host.querySelector(".palette-session-settings__workspace")?.textContent).toContain(
      "updated-default",
    );
    expect(host.draft.message).toBe("Keep this exact prompt");
    expect(host.querySelector("textarea")).toBe(prompt);
    expect([prompt.selectionStart, prompt.selectionEnd]).toEqual([5, 9]);
    await vi.waitFor(() => expect(entries[PALETTE_PREFERENCE_KEY]).toBeUndefined());
    expect(entries["new-session.v1:main"]).toMatchObject({ folder: "/updated-default" });
    expect(writes.at(-1)).toEqual({ [PALETTE_PREFERENCE_KEY]: null });
  });

  it("shows failed saves, retains one-off choices and retries through the same owner", async () => {
    const { host, entries, remember, select, setReject } = await mountPreferences();
    select().onSelect("other");
    setReject(true);
    remember().click();
    await vi.waitFor(() =>
      expect(host.querySelector('.palette-session-settings__error[role="alert"]')).not.toBeNull(),
    );
    expect(entries[PALETTE_PREFERENCE_KEY]).toBeUndefined();
    expect(remember().checked).toBe(false);
    expect(select().value).toBe("other");
    host.draft.close();
    host.draft.open();
    await host.updateComplete;
    expect(host.querySelector('.palette-session-settings__error[role="alert"]')).not.toBeNull();
    setReject(false);
    expectDefined(
      host.querySelector<HTMLButtonElement>(".palette-session-settings__error button"),
      "retry settings save",
    ).click();
    await vi.waitFor(() =>
      expect(entries[PALETTE_PREFERENCE_KEY]).toMatchObject({ agentId: "other" }),
    );
    await vi.waitFor(() => expect(remember().checked).toBe(true));
  });

  it("restores defaults immediately when deletion fails and keeps a retryable error", async () => {
    const { host, entries, select, remember, setReject } = await mountPreferences({
      [PALETTE_PREFERENCE_KEY]: {
        agentId: "other",
        selection: { folder: "/other", worktree: false },
      },
    });
    await vi.waitFor(() => expect(select().value).toBe("other"));
    host.draft.setMessage("Keep this task");
    setReject(true);
    remember().click();
    await host.updateComplete;
    expect(select().value).toBe("main");
    expect(host.draft.message).toBe("Keep this task");
    await vi.waitFor(() =>
      expect(host.querySelector('.palette-session-settings__error[role="alert"]')).not.toBeNull(),
    );
    expect(entries[PALETTE_PREFERENCE_KEY]).toMatchObject({ agentId: "other" });
    expect(remember().checked).toBe(false);
    setReject(false);
    expectDefined(
      host.querySelector<HTMLButtonElement>(".palette-session-settings__error button"),
      "retry clearing remembered settings",
    ).click();
    await vi.waitFor(() => expect(entries[PALETTE_PREFERENCE_KEY]).toBeUndefined());
    expect(select().value).toBe("main");
  });

  it("keeps local selections through same-user reconnect but never adopts another owner's override", async () => {
    const { host, context, publish, entries, select, remember } = await mountPreferences({
      [PALETTE_PREFERENCE_KEY]: {
        agentId: "other",
        selection: { folder: "/other", worktree: false },
      },
    });
    await vi.waitFor(() => expect(select().value).toBe("other"));
    remember().click();
    await vi.waitFor(() => expect(entries[PALETTE_PREFERENCE_KEY]).toBeUndefined());
    select().onSelect("other");
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
      expectDefined(
        host.querySelector<HTMLButtonElement>(".palette-session-settings__workspace"),
        "workspace picker",
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
        expect(host.querySelector(".palette-session-settings__search")).toBe(search);
        expect(document.activeElement).toBe(search);
      }
    },
  );

  it("renders machine-grouped workspace choices instead of an always-visible toolbar", async () => {
    const { host } = await mountPreferences();
    expect(host.querySelector(".palette-session-settings__trigger")).not.toBeNull();
    expect(host.querySelector(".new-session-page__where-popover")).toBeNull();
    expectDefined(
      host.querySelector<HTMLButtonElement>(".palette-session-settings__workspace"),
      "workspace picker",
    ).click();
    await host.updateComplete;
    expect(
      host.querySelector('section[aria-label="Local"] [data-machine="local"][data-project=""]'),
    ).not.toBeNull();
    const search = expectDefined(
      host.querySelector<HTMLInputElement>(".palette-session-settings__search"),
      "workspace search",
    );
    search.value = "no-such-workspace";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await host.updateComplete;
    expect(host.querySelector("[data-machine]")).toBeNull();
    search.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await host.updateComplete;
    expect(host.querySelector(".palette-session-settings__workspace")).not.toBeNull();
  });
});
