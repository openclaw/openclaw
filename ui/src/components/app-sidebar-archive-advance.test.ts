/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSidebarArchiveAdvance,
  resolveArchiveSuccessor,
  type SidebarArchiveAdvanceHost,
} from "./app-sidebar-archive-advance.ts";
import { holdArchive } from "./session-archive-hold.ts";

const ORDER = ["agent:main:alpha", "agent:main:bravo", "agent:main:charlie"];

describe("resolveArchiveSuccessor", () => {
  const always = () => true;

  it("prefers the chat below, then the chat above, and skips chats it cannot open", () => {
    expect(resolveArchiveSuccessor("agent:main:bravo", ORDER, always)).toBe("agent:main:charlie");
    expect(resolveArchiveSuccessor("agent:main:charlie", ORDER, always)).toBe("agent:main:bravo");
    expect(
      resolveArchiveSuccessor("agent:main:alpha", ORDER, (key) => key !== "agent:main:bravo"),
    ).toBe("agent:main:charlie");
  });

  it("has no successor for the only chat or a chat outside the sidebar", () => {
    expect(
      resolveArchiveSuccessor("agent:main:alpha", ["agent:main:alpha"], always),
    ).toBeUndefined();
    expect(resolveArchiveSuccessor("agent:main:other", ORDER, always)).toBeUndefined();
  });
});

describe("createSidebarArchiveAdvance", () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    stops.splice(0).forEach((stop) => stop());
  });

  function setup(current: string, order = ORDER) {
    let open = current;
    let rendered = order;
    const openSession = vi.fn((key: string) => {
      open = key;
    });
    const host: SidebarArchiveAdvanceHost = {
      currentSessionKey: () => open,
      visibleSessionKeysInOrder: () => rendered,
      canOpenSession: (key) => rendered.includes(key),
      openSession,
    };
    const advance = createSidebarArchiveAdvance(host);
    stops.push(() => advance.disconnect());
    advance.sync();
    const archive = async (keys: string[]) => {
      // The runtime hides the rows before the archive enters its Undo window.
      rendered = rendered.filter((key) => !keys.includes(key));
      stops.push(holdArchive({ keys, settle: () => undefined }));
      await Promise.resolve();
    };
    return { advance, archive, openSession, navigate: (key: string) => (open = key) };
  }

  it("opens the chat below when the open chat is archived", async () => {
    const { archive, openSession } = setup("agent:main:bravo");
    await archive(["agent:main:bravo"]);
    expect(openSession).toHaveBeenCalledExactlyOnceWith("agent:main:charlie");
  });

  it("opens the chat above when the last chat is archived", async () => {
    const { archive, openSession } = setup("agent:main:charlie");
    await archive(["agent:main:charlie"]);
    expect(openSession).toHaveBeenCalledExactlyOnceWith("agent:main:bravo");
  });

  it("skips every chat in a batch archive", async () => {
    const { archive, openSession } = setup("agent:main:alpha");
    await archive(["agent:main:alpha", "agent:main:bravo"]);
    expect(openSession).toHaveBeenCalledExactlyOnceWith("agent:main:charlie");
  });

  it("stays put when another chat is archived, outside chats, and after disconnecting", async () => {
    const other = setup("agent:main:bravo");
    await other.archive(["agent:main:alpha"]);
    expect(other.openSession).not.toHaveBeenCalled();

    const outside = setup("");
    await outside.archive(["agent:main:bravo"]);
    expect(outside.openSession).not.toHaveBeenCalled();

    const disconnected = setup("agent:main:bravo");
    disconnected.advance.disconnect();
    await disconnected.archive(["agent:main:bravo"]);
    expect(disconnected.openSession).not.toHaveBeenCalled();
  });

  it("keeps the archived chat open when nothing else is in the sidebar", async () => {
    const { archive, openSession } = setup("agent:main:alpha", ["agent:main:alpha"]);
    await archive(["agent:main:alpha"]);
    expect(openSession).not.toHaveBeenCalled();
  });

  it("does not override a chat the user opened before the archive settled", async () => {
    const { advance, openSession, navigate } = setup("agent:main:bravo");
    stops.push(holdArchive({ keys: ["agent:main:bravo"], settle: () => undefined }));
    navigate("agent:main:alpha");
    await Promise.resolve();
    expect(openSession).not.toHaveBeenCalled();
    advance.disconnect();
  });
});
