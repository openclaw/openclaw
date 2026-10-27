/* @vitest-environment jsdom */
import type { UsersMentionableResult } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../../packages/gateway-protocol/src/startup-unavailable.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { requestSessionCreate } from "../lib/sessions/create.ts";
import * as toast from "../lib/toast.ts";
import { createDraftFixture } from "../pages/new-session/draft-submission-flow.test-support.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import {
  mountPalette,
  openPalette,
  prepareDraftContext,
  pressKey,
} from "./command-palette.test-support.ts";
import "./command-palette.tsx";

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

async function mount(
  createdSessionKey = "agent:main:dashboard:mentioned",
  scopes = ["operator.read", "operator.write"],
) {
  const directory = vi.fn(async (): Promise<UsersMentionableResult> => people);
  const fixture = createDraftFixture({
    scopes,
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
  const publish = prepareDraftContext(context);
  for (const capability of [context.agents, context.sessions, context.config]) {
    Object.assign(capability, { subscribe: () => () => {} });
  }
  vi.mocked(context.sessions.createResult).mockImplementation((params) =>
    requestSessionCreate(context.gateway.snapshot.client!, params),
  );
  const { palette, provider, query } = await mountPalette(context);
  const getInput = () => palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
  await openPalette(palette);
  getInput().focus();
  const edit = async (start: number, end: number, text: string, inputType = "insertText") => {
    const input = getInput();
    const previous = input.value;
    input.setSelectionRange(start, end);
    const event = {
      bubbles: true,
      inputType,
      data: inputType.startsWith("delete") ? null : text,
    };
    input.dispatchEvent(new InputEvent("beforeinput", { ...event, cancelable: true }));
    input.value = previous.slice(0, start) + text + previous.slice(end);
    const caret = start + text.length;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new InputEvent("input", event));
    await palette.updateComplete;
  };
  const append = (text: string) => edit(getInput().value.length, getInput().value.length, text);
  const replace = (text: string, inputType = "insertText") =>
    edit(0, getInput().value.length, text, inputType);
  const key = async (pressedKey: string, extra: KeyboardEventInit = {}) => {
    const event = pressKey(getInput(), pressedKey, { cancelable: true, ...extra });
    await palette.updateComplete;
    return event;
  };
  const search = async (text = "@") => {
    await append(text);
    await vi.advanceTimersByTimeAsync(150);
    await palette.updateComplete;
  };
  const choose = async (keyName?: string) => {
    await search();
    if (keyName) {
      await key(keyName);
    }
    await key("Enter");
  };
  const menu = () => palette.querySelector(".mention-menu");
  const recipients = () => [...palette.querySelectorAll(".composer-context-strip__person")];
  const select = async (start: number, end: number) => {
    getInput().setSelectionRange(start, end);
    getInput().dispatchEvent(new Event("select", { bubbles: true }));
    await palette.updateComplete;
  };
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
    choose,
    menu,
    recipients,
    send,
    select,
    query,
    publish,
    expectCreate: (params: object) =>
      expect(fixture.request).toHaveBeenCalledWith(
        "sessions.create",
        expect.objectContaining(params),
        expect.objectContaining({ timeoutMs: GATEWAY_STARTUP_ADMISSION_WAIT_MS }),
      ),
  };
}

describe("command palette people mentions", () => {
  it.each([
    { role: "operator", scopes: ["operator.read", "operator.write"] },
    { role: "guest", scopes: ["operator.sessions.write"] },
  ])("carries selected people into the first message for a $role", async ({ scopes }) => {
    const f = await mount(undefined, scopes);
    await f.search("  🙂 @");
    expect(f.input.getAttribute("aria-controls")).toBe(f.menu()?.id);
    expect(f.input.getAttribute("aria-haspopup")).toBe("listbox");
    expect(f.input.hasAttribute("aria-expanded")).toBe(false);
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
    await f.choose("ArrowDown");
    expect(f.recipients()).toHaveLength(2);
    expect(f.context.sessions.createResult).not.toHaveBeenCalled();
    const expected = [
      { profileId: "alex-two", start: 3, end: 8 },
      { profileId: "jordan", start: 9, end: 23 },
      { profileId: "alex-two", start: 24, end: 29 },
    ];
    await f.send();
    f.expectCreate({ message: "🙂 @Alex @Jordan Rivera @Alex", mentions: expected });
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

  it("resumes search after removing a recipient without deleting its visible text", async () => {
    const f = await mount();
    await f.choose();
    await f.choose("End");
    await f.edit(3, 4, "", "deleteContentForward");
    expect(f.recipients()).toHaveLength(1);
    const value = f.input.value;
    vi.mocked(f.context.sessions.list).mockClear();
    f.query<HTMLButtonElement>('button[aria-label="Remove mention"]')!.click();
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

  it("keeps name selections but closes when the selection leaves the invocation", async () => {
    const f = await mount();
    const searchSessions = vi.mocked(f.context.sessions.list);
    searchSessions.mockClear();
    await f.append("Review @");
    await f.search("Al");
    expect(f.directoryParams()).toEqual([{ agentId: "main", query: "Al" }]);
    expect(f.menu()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(searchSessions).not.toHaveBeenCalled();
    await f.select(8, 10);
    expect(f.menu()).not.toBeNull();
    await f.select(0, 0);
    expect(f.menu()).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(searchSessions).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ search: "Review @Al" }),
    );
    expect(f.recipients()).toHaveLength(0);
  });

  it.each(["insertFromPaste", "insertFromDrop", "modified send"])(
    "does not turn unselected text into a mention on %s",
    async (inputType) => {
      const f = await mount();
      const message = inputType === "modified send" ? "@" : "@Alex";
      if (inputType === "modified send") {
        await f.search();
        expect((await f.key("Enter", { shiftKey: true })).defaultPrevented).toBe(false);
        expect((await f.key("Tab", { shiftKey: true })).defaultPrevented).toBe(false);
        expect(f.recipients()).toHaveLength(0);
      } else {
        await f.replace(message, inputType);
        await vi.advanceTimersByTimeAsync(150);
        expect(f.directory).not.toHaveBeenCalled();
      }
      await f.send();
      f.expectCreate({ message });
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

  it("shows loading and empty states without accidentally sending", async () => {
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
  });

  it("retains selected recipients on a rejected first turn without duplicate creation", async () => {
    const f = await mount();
    vi.mocked(f.context.sessions.createResult).mockResolvedValueOnce({
      key: "agent:main:dashboard:rejected",
      initialRun: { status: "rejected", error: "First turn rejected" },
    });
    await f.choose();
    await f.send();
    expect(f.query('[role="alert"]')?.textContent).toContain("First turn rejected");
    expect(f.recipients()).toHaveLength(1);
    await f.key("Escape");
    await openPalette(f.palette);
    expect(f.recipients()).toHaveLength(1);
    pressKey(f.input, "Enter", { ctrlKey: true, cancelable: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.context.sessions.createResult).toHaveBeenCalledOnce();
  });

  it("locks recipients while submitting and never sends twice", async () => {
    const f = await mount();
    const pending = createDeferred<Awaited<ReturnType<typeof requestSessionCreate>>>();
    vi.mocked(f.context.sessions.createResult).mockReturnValueOnce(pending.promise);
    await f.choose();
    await f.send();
    expect(f.input).toMatchObject({ disabled: false, readOnly: true });
    expect(f.input.getAttribute("aria-busy")).toBe("true");
    expect(f.query(".cmd-palette__mentions")?.hasAttribute("inert")).toBe(true);
    f.query<HTMLButtonElement>('button[aria-label="Remove mention"]')!.click();
    await f.send();
    expect(f.context.sessions.createResult).toHaveBeenCalledOnce();
    expect(f.recipients()).toHaveLength(1);
    pending.resolve({
      key: "agent:main:dashboard:mentioned",
      initialRun: { status: "started", runId: "mention-run" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.palette.isOpen).toBe(false);
  });

  it.each(["anonymous", "read-only", "session-read-only", "offline", "create-unavailable"])(
    "does not query a directory for %s operators",
    async (mode) => {
      const f = await mount();
      if (mode === "anonymous") {
        Object.assign(f.context.gateway.snapshot, { selfUser: undefined });
      } else if (mode === "read-only") {
        Object.assign(f.context.gateway.snapshot.hello!.auth!, { scopes: ["operator.read"] });
      } else if (mode === "session-read-only") {
        Object.assign(f.context.gateway.snapshot.hello!.auth!, {
          scopes: ["operator.sessions.read"],
        });
      } else if (mode === "create-unavailable") {
        f.context.gateway.snapshot.hello!.features!.methods = [];
      } else {
        f.context.gateway.snapshot.phase = "reconnecting";
      }
      f.publish();
      await f.palette.updateComplete;
      // An identity change closes the old draft before the next opening.
      if (!f.palette.isOpen) {
        await openPalette(f.palette);
      }
      await f.search();
      expect(f.directory).not.toHaveBeenCalled();
      expect(f.menu()).toBeNull();
    },
  );

  it.each(["close", "owner", "detach", "reconnect", "destination"])(
    "keeps a new visible invocation authoritative after %s",
    async (change) => {
      const destination = change === "destination" ? "reviewer" : "main";
      const f = await mount(
        `agent:${destination}:dashboard:mentioned`,
        change === "destination" ? ["operator.sessions.write"] : undefined,
      );
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
        f.query<HTMLButtonElement>(".palette-session-settings__trigger")!.click();
        await waitForSolid(() =>
          expect(f.query(".palette-session-settings")?.matches(":popover-open")).toBe(true),
        );
        const agent = f.query("openclaw-agent-select")!;
        await agent.updateComplete;
        expect(agent.value).toBe("main");
        for (const item of agent.querySelectorAll<HTMLElement>("[role='menuitemradio']")) {
          item.scrollIntoView = vi.fn();
        }
        agent.querySelector<HTMLButtonElement>(".agent-select__trigger")!.click();
        await waitForSolid(() =>
          expect(agent.querySelector(".agent-select__menu")?.matches(":popover-open")).toBe(true),
        );
        const reviewer = agent.querySelector<HTMLElement>(
          '.agent-select__option[aria-label="Reviewer"]',
        )!;
        expect(reviewer).not.toBeNull();
        reviewer.click();
        await waitForSolid(() => expect(agent.value).toBe("reviewer"));
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
        await openPalette(f.palette);
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
      f.expectCreate({
        agentId: destination,
        message: "@New Person",
        mentions: [{ profileId: "new-person", start: 0, end: 11 }],
      });
      expect(f.context.gateway.snapshot.sessionKey).toBe(foreground);
      expect(f.context.agentSelection.state.selectedId).toBe("main");
    },
  );
});
