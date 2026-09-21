/* @vitest-environment jsdom */
import type { UsersMentionableResult } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createWebPushCapability } from "../app/web-push.ts";
import { requestSessionCreate } from "../lib/sessions/create.ts";
import * as toast from "../lib/toast.ts";
import { createDraftFixture } from "../pages/new-session/draft-submission-flow.test-support.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { mountPalette } from "./command-palette.test-support.ts";
import "./command-palette.ts";

const people: UsersMentionableResult = {
  users: [
    { profileId: "alex-one", displayName: "Alex", online: true },
    { profileId: "alex-two", displayName: "Alex", online: false },
    { profileId: "jordan", displayName: "Jordan Rivera", online: false },
  ],
  truncated: false,
};
let restoreDialog: () => void;
beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
  restoreDialog = installDialogPolyfill();
  vi.spyOn(toast, "showToast").mockReturnValue(true);
});
afterEach(() => {
  document.body.replaceChildren();
  restoreDialog();
  localStorage.clear();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount(createdSessionKey = "agent:main:dashboard:mentioned") {
  const directory = vi.fn(async (): Promise<UsersMentionableResult> => people);
  const fixture = createDraftFixture({
    request: async (method) => {
      if (method === "users.mentionable") {
        return directory();
      }
      if (method === "sessions.create") {
        return { key: createdSessionKey, runStarted: true, runId: "mention-run" };
      }
      return {};
    },
  });
  const { context } = fixture;
  Object.assign(context.gateway.snapshot, {
    selfUser: { id: "sender", identity: { type: "profile", id: "sender" } },
  });
  const connection = createApplicationGateway(context.gateway.snapshot);
  Object.assign(connection.gateway, {
    connectionRevision: 1,
    connection: context.gateway.connection,
    setSessionKey: context.gateway.setSessionKey,
  });
  const webPush = createWebPushCapability(connection.gateway);
  onTestFinished(() => webPush.dispose());
  Object.assign(context, {
    gateway: connection.gateway,
    webPush,
    agentIdentity: {
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
      get: () => undefined,
    },
    navigate: vi.fn(),
  });
  for (const capability of [
    context.agentSelection,
    context.agents,
    context.sessions,
    context.config,
  ]) {
    Object.assign(capability, { subscribe: () => () => {} });
  }
  Object.assign(context.agents.state, { connected: true, client: context.gateway.snapshot.client });
  Object.assign(context.sessions, { list: vi.fn(async () => null) });
  vi.mocked(context.sessions.createResult).mockImplementation((params) =>
    requestSessionCreate(context.gateway.snapshot.client!, params),
  );
  const { palette, provider } = await mountPalette(context);
  const getInput = () => palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
  palette.openPalette();
  await palette.updateComplete;
  getInput().focus();
  const edit = async (options: {
    start: number;
    end: number;
    text: string;
    inputType?: string;
  }) => {
    const input = getInput();
    const previous = input.value;
    input.setSelectionRange(options.start, options.end);
    const inputType = options.inputType ?? "insertText";
    const event = {
      bubbles: true,
      inputType,
      data: inputType.startsWith("delete") ? null : options.text,
    };
    input.dispatchEvent(new InputEvent("beforeinput", { ...event, cancelable: true }));
    input.value = previous.slice(0, options.start) + options.text + previous.slice(options.end);
    const caret = options.start + options.text.length;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new InputEvent("input", event));
    await palette.updateComplete;
  };
  const append = (text: string) =>
    edit({ start: getInput().value.length, end: getInput().value.length, text });
  const replace = (text: string, inputType = "insertText") =>
    edit({ start: 0, end: getInput().value.length, text, inputType });
  const key = async (pressedKey: string, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: pressedKey,
      ...extra,
    });
    getInput().dispatchEvent(event);
    await palette.updateComplete;
    return event;
  };
  const search = async (text = "@") => {
    await append(text);
    await vi.advanceTimersByTimeAsync(150);
    await palette.updateComplete;
  };
  const menu = () => palette.querySelector(".mention-menu");
  const recipients = () => [...palette.querySelectorAll(".composer-context-strip__person")];
  const send = async () => {
    await vi.advanceTimersByTimeAsync(0);
    await key("Enter", { ctrlKey: true });
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
  };
  return {
    ...fixture,
    palette,
    provider,
    get input() {
      return getInput();
    },
    directory,
    directoryParams: () =>
      fixture.request.mock.calls
        .filter(([method]) => method === "users.mentionable")
        .map(([, params]) => params),
    edit,
    append,
    replace,
    key,
    search,
    menu,
    recipients,
    send,
    publish: () => connection.publish(context.gateway.snapshot),
  };
}

describe("command palette people mentions", () => {
  it("selects one, two, and repeated references and carries real first-message metadata", async () => {
    const f = await mount();
    await f.search("  🙂 @");
    expect(f.input.getAttribute("aria-controls")).toBe(f.menu()?.id);
    const active = f.menu()?.querySelector('[role="option"][aria-selected="true"]');
    expect(f.input.getAttribute("aria-activedescendant")).toBe(active?.id);
    await f.key("ArrowDown");
    await f.key("Enter");
    expect(f.input.value).toBe("  🙂 @Alex ");
    expect(f.recipients()).toHaveLength(1);
    await f.search();
    await f.key("End");
    await f.key("Tab");
    expect(f.recipients()).toHaveLength(2);
    await f.search();
    await f.key("ArrowDown");
    await f.key("Enter");
    expect(f.recipients()).toHaveLength(2);
    expect(f.context.sessions.createResult).not.toHaveBeenCalled();
    const expected = [
      { profileId: "alex-two", start: 3, end: 8 },
      { profileId: "jordan", start: 9, end: 23 },
      { profileId: "alex-two", start: 24, end: 29 },
    ];
    await f.send();
    expect(f.request).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({ message: "🙂 @Alex @Jordan Rivera @Alex", mentions: expected }),
    );
    const retained = f.context.chatSubmissions.readInitial(
      "agent:main:dashboard:mentioned",
      f.context.gateway.snapshot.client,
    );
    expect(retained?.message?.["__openclaw"].humanMentions).toEqual(expected);
    expect(f.context.navigateAndWait).not.toHaveBeenCalled();
    expect(f.palette.isOpen).toBe(false);
    f.palette.openPalette();
    await f.palette.updateComplete;
    expect(f.palette.querySelector("textarea")?.value).toBe("");
    expect(f.recipients()).toHaveLength(0);
  });

  it("preserves same-name identity through exact editing and inserts at the caret", async () => {
    const f = await mount();
    await f.search();
    await f.key("Enter");
    await f.search();
    await f.key("ArrowDown");
    await f.key("Enter");
    await f.edit({ start: 0, end: 6, text: "", inputType: "deleteContentForward" });
    expect(f.recipients()).toHaveLength(1);
    await f.edit({ start: 0, end: 0, text: "Review " });
    await f.append(" tail");
    await f.edit({ start: 13, end: 13, text: "@" });
    await vi.advanceTimersByTimeAsync(150);
    await f.key("End");
    await f.key("Enter");
    expect(f.input.value).toBe("Review @Alex @Jordan Rivera  tail");
    expect(f.input.selectionStart).toBe(28);
    await f.send();
    expect(f.request).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({
        mentions: [
          { profileId: "alex-two", start: 7, end: 12 },
          { profileId: "jordan", start: 13, end: 27 },
        ],
      }),
    );
  });

  it("keeps name selections but closes when the selection leaves the invocation", async () => {
    const f = await mount();
    await f.append("Review @");
    await f.search("Al");
    expect(f.directoryParams()).toEqual([{ agentId: "main", query: "Al" }]);
    expect(f.menu()).not.toBeNull();
    f.input.setSelectionRange(8, 10);
    f.input.dispatchEvent(new Event("select", { bubbles: true }));
    await f.palette.updateComplete;
    expect(f.menu()).not.toBeNull();
    f.input.setSelectionRange(0, 0);
    f.input.dispatchEvent(new Event("select", { bubbles: true }));
    await f.palette.updateComplete;
    expect(f.menu()).toBeNull();
    await f.replace("Review @Jo");
    await vi.advanceTimersByTimeAsync(150);
    expect(f.menu()).not.toBeNull();
    f.input.setSelectionRange(7, 10);
    f.input.dispatchEvent(new Event("select", { bubbles: true }));
    await f.palette.updateComplete;
    expect(f.menu()).toBeNull();
    expect(f.recipients()).toHaveLength(0);
  });

  it("removes edited references and clears selections without deleting prose", async () => {
    const f = await mount();
    await f.search();
    await f.key("Enter");
    await f.search();
    await f.key("End");
    await f.key("Enter");
    await f.edit({ start: 3, end: 4, text: "", inputType: "deleteContentForward" });
    expect(f.recipients()).toHaveLength(1);
    const value = f.input.value;
    vi.mocked(f.context.sessions.list).mockClear();
    f.palette.querySelector<HTMLButtonElement>('button[aria-label="Remove mention"]')!.click();
    await f.palette.updateComplete;
    expect(f.input.value).toBe(value);
    expect(f.recipients()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.context.sessions.list).toHaveBeenCalledWith(
      expect.objectContaining({ search: value.trim() }),
    );
    await f.send();
    const create = f.request.mock.calls.find(([method]) => method === "sessions.create")?.[1];
    expect(create).not.toHaveProperty("mentions");
  });

  it.each(["insertFromPaste", "insertFromDrop"])(
    "does not select or look up text from %s",
    async (inputType) => {
      const f = await mount();
      await f.replace("@Alex", inputType);
      await vi.advanceTimersByTimeAsync(150);
      expect(f.directory).not.toHaveBeenCalled();
      await f.send();
      expect(f.request).toHaveBeenCalledWith(
        "sessions.create",
        expect.objectContaining({ message: "@Alex" }),
      );
      const create = f.request.mock.calls.find(([method]) => method === "sessions.create")?.[1];
      expect(create).not.toHaveProperty("mentions");
      expect(f.palette.isOpen).toBe(false);
    },
  );

  it("closes people before the palette and leaves composition keys to the IME", async () => {
    const f = await mount();
    await f.search();
    await f.key("Enter", { isComposing: true });
    expect(f.recipients()).toHaveLength(0);
    await f.key("Escape");
    expect(f.menu()).toBeNull();
    expect(f.palette.isOpen).toBe(true);
    f.input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await f.palette.updateComplete;
    expect((await f.key("Enter", { ctrlKey: true })).defaultPrevented).toBe(false);
    await f.key("Escape");
    expect(f.palette.isOpen).toBe(true);
    f.input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await f.palette.updateComplete;
    await f.key("Escape");
    expect(f.palette.isOpen).toBe(false);
    expect(f.context.sessions.createResult).not.toHaveBeenCalled();
  });

  it("shows loading, empty, and retry states without accidentally sending", async () => {
    const f = await mount();
    f.directory.mockResolvedValueOnce({ users: [], truncated: false });
    await f.append("@Nobody");
    expect(f.menu()?.querySelector('[aria-busy="true"]')).toBeTruthy();
    await f.key("Enter");
    expect(f.context.sessions.createResult).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(f.menu()?.textContent).toContain("No people found");
    await f.key("Tab");
    expect(f.context.sessions.createResult).not.toHaveBeenCalled();
    f.directory.mockRejectedValueOnce(new Error("unavailable"));
    await f.replace("@Alex");
    await vi.advanceTimersByTimeAsync(150);
    const retry = f.palette.querySelector<HTMLButtonElement>(".mention-menu__retry")!;
    expect(retry.textContent?.trim()).toBe("Retry");
    expect((await f.key("Tab")).defaultPrevented).toBe(false);
    retry.click();
    await vi.advanceTimersByTimeAsync(150);
    expect(f.menu()?.querySelectorAll('[role="option"]')).toHaveLength(3);
  });

  it("retains selected recipients on a rejected first turn without duplicate creation", async () => {
    const f = await mount();
    vi.mocked(f.context.sessions.createResult).mockResolvedValueOnce({
      key: "agent:main:dashboard:rejected",
      initialRun: { status: "rejected", error: "First turn rejected" },
    });
    await f.search();
    await f.key("Enter");
    await f.send();
    expect(f.palette.querySelector('[role="alert"]')?.textContent).toContain("First turn rejected");
    expect(f.recipients()).toHaveLength(1);
    await f.key("Escape");
    f.palette.openPalette();
    await f.palette.updateComplete;
    expect(f.recipients()).toHaveLength(1);
    const input = f.palette.querySelector<HTMLTextAreaElement>("textarea")!;
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.context.sessions.createResult).toHaveBeenCalledOnce();
  });

  it("locks recipients while submitting and never sends twice", async () => {
    const f = await mount();
    let finish!: (value: Awaited<ReturnType<typeof requestSessionCreate>>) => void;
    vi.mocked(f.context.sessions.createResult).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await f.search();
    await f.key("Enter");
    await f.send();
    expect(f.input.disabled).toBe(true);
    expect(f.palette.querySelector(".cmd-palette__mentions")?.hasAttribute("inert")).toBe(true);
    f.palette.querySelector<HTMLButtonElement>('button[aria-label="Remove mention"]')!.click();
    await f.send();
    expect(f.context.sessions.createResult).toHaveBeenCalledOnce();
    expect(f.recipients()).toHaveLength(1);
    finish({
      key: "agent:main:dashboard:mentioned",
      initialRun: { status: "started", runId: "mention-run" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.palette.isOpen).toBe(false);
  });

  it.each(["anonymous", "read-only", "offline"])(
    "does not query a directory for %s operators",
    async (mode) => {
      const f = await mount();
      if (mode === "anonymous") {
        Object.assign(f.context.gateway.snapshot, { selfUser: undefined });
      } else if (mode === "read-only") {
        Object.assign(f.context.gateway.snapshot.hello!.auth!, { scopes: ["operator.read"] });
      } else {
        f.context.gateway.snapshot.phase = "reconnecting";
      }
      f.publish();
      await f.palette.updateComplete;
      // An identity change closes the old draft before the next opening.
      if (!f.palette.isOpen) {
        f.palette.openPalette();
        await f.palette.updateComplete;
      }
      await f.search();
      expect(f.directory).not.toHaveBeenCalled();
      expect(f.menu()).toBeNull();
    },
  );

  it("keeps Shift+Enter and modified send independent from people selection", async () => {
    const f = await mount();
    await f.search();
    expect((await f.key("Enter", { shiftKey: true })).defaultPrevented).toBe(false);
    expect((await f.key("Tab", { shiftKey: true })).defaultPrevented).toBe(false);
    expect(f.recipients()).toHaveLength(0);
    await f.send();
    expect(f.request).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({ message: "@" }),
    );
    expect(
      f.request.mock.calls.find(([method]) => method === "sessions.create")?.[1],
    ).not.toHaveProperty("mentions");
  });

  it.each(["close", "owner", "detach", "reconnect", "destination"])(
    "keeps a new visible invocation authoritative after %s",
    async (change) => {
      const destination = change === "destination" ? "reviewer" : "main";
      const f = await mount(`agent:${destination}:dashboard:mentioned`);
      const foreground = "agent:main:dashboard:foreground";
      f.context.gateway.snapshot.sessionKey = foreground;
      if (change === "destination") {
        const roster = f.context.agents.state.agentsList!;
        Object.assign(f.context.agents.state, {
          agentsList: {
            ...roster,
            agents: [...roster.agents, { ...roster.agents[0], id: "reviewer", name: "Reviewer" }],
          },
        });
      }
      const oldResponse = createDeferred<UsersMentionableResult>();
      const newResponse = createDeferred<UsersMentionableResult>();
      f.directory.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
      await f.search("@old");
      expect(f.directory).toHaveBeenCalledOnce();
      expect(f.directoryParams()).toEqual([{ agentId: "main", query: "old" }]);

      if (change === "close") {
        f.palette.togglePalette();
      } else if (change === "owner") {
        Object.assign(f.context.gateway, { connectionRevision: 2 });
        f.publish();
      } else if (change === "detach") {
        f.palette.remove();
        f.provider.append(f.palette);
      } else if (change === "destination") {
        const agent = f.palette.querySelector("openclaw-agent-select")!;
        await agent.updateComplete;
        expect(agent.value).toBe("main");
        const reviewer = agent.querySelector('wa-dropdown-item[aria-label="Reviewer"]')!;
        expect(reviewer).not.toBeNull();
        agent.querySelector("wa-dropdown")!.dispatchEvent(
          new CustomEvent("wa-select", {
            bubbles: true,
            cancelable: true,
            detail: { item: reviewer },
          }),
        );
        await f.palette.updateComplete;
        await agent.updateComplete;
        expect(agent.value).toBe("reviewer");
        expect(f.context.agentSelection.state.selectedId).toBe("main");
        expect(f.menu()).toBeNull();
      } else {
        f.context.gateway.snapshot.phase = "reconnecting";
        f.publish();
        await f.palette.updateComplete;
        expect(f.palette.isOpen).toBe(true);
        expect(f.input.value).toBe("@old");
        expect(f.menu()).toBeNull();
        f.context.gateway.snapshot.phase = "connected";
        f.publish();
      }
      await f.palette.updateComplete;
      if (change !== "reconnect" && change !== "destination") {
        expect(f.palette.isOpen).toBe(false);
        f.palette.openPalette();
        await f.palette.updateComplete;
      }
      f.input.focus();
      await f.replace("@new");
      await vi.advanceTimersByTimeAsync(150);
      expect(f.directory).toHaveBeenCalledTimes(2);
      expect(f.directoryParams()).toEqual([
        { agentId: "main", query: "old" },
        { agentId: destination, query: "new" },
      ]);
      expect(f.palette.isOpen).toBe(true);
      expect(f.menu()?.querySelector('[aria-busy="true"]')).toBeTruthy();

      oldResponse.resolve(people);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.menu()?.querySelector('[aria-busy="true"]')).toBeTruthy();
      expect(f.menu()?.querySelectorAll('[role="option"]')).toHaveLength(0);
      expect(f.recipients()).toHaveLength(0);

      newResponse.resolve({
        users: [{ profileId: "new-person", displayName: "New Person", online: true }],
        truncated: false,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.menu()?.querySelector('[role="option"]')?.textContent).toContain("New Person");
      expect(f.menu()?.textContent).not.toContain("Alex");
      await f.key("Enter");
      expect(f.input.value).toBe("@New Person ");
      await f.send();
      expect(f.request).toHaveBeenCalledWith(
        "sessions.create",
        expect.objectContaining({
          agentId: destination,
          message: "@New Person",
          mentions: [{ profileId: "new-person", start: 0, end: 11 }],
        }),
      );
      expect(f.context.gateway.snapshot.sessionKey).toBe(foreground);
      expect(f.context.agentSelection.state.selectedId).toBe("main");
    },
  );
});
