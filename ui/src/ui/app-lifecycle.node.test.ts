import { describe, expect, it, vi } from "vitest";
import { handleDisconnected, handleUpdated, syncDocumentTitle } from "./app-lifecycle.ts";

function createHost() {
  return {
    basePath: "",
    client: { stop: vi.fn() },
    connected: true,
    tab: "chat",
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAgentId: null,
    chatHasAutoScrolled: false,
    chatManualRefreshInFlight: false,
    chatLoading: false,
    chatMessages: [],
    chatToolMessages: [],
    chatStream: null,
    logsAutoFollow: false,
    logsAtBottom: true,
    logsEntries: [],
    popStateHandler: vi.fn(),
    topbarObserver: { disconnect: vi.fn() } as unknown as ResizeObserver,
  };
}

describe("handleDisconnected", () => {
  it("stops and clears gateway client on teardown", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener").mockImplementation(() => undefined);
    const host = createHost();
    const disconnectSpy = (
      host.topbarObserver as unknown as { disconnect: ReturnType<typeof vi.fn> }
    ).disconnect;

    handleDisconnected(host as unknown as Parameters<typeof handleDisconnected>[0]);

    expect(removeSpy).toHaveBeenCalledWith("popstate", host.popStateHandler);
    expect(host.client).toBeNull();
    expect(host.connected).toBe(false);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(host.topbarObserver).toBeNull();
    removeSpy.mockRestore();
  });
});

describe("syncDocumentTitle", () => {
  it("sets base title when assistant name is the default", () => {
    syncDocumentTitle("Assistant");
    expect(document.title).toBe("OpenClaw Control");
  });

  it("sets base title when assistant name is empty", () => {
    syncDocumentTitle("");
    expect(document.title).toBe("OpenClaw Control");
  });

  it("includes agent name in title for named agents", () => {
    syncDocumentTitle("Tony");
    expect(document.title).toBe("OpenClaw \u2014 Tony");
  });

  it("includes agent name for non-default names", () => {
    syncDocumentTitle("Claw");
    expect(document.title).toBe("OpenClaw \u2014 Claw");
  });
});

describe("handleUpdated", () => {
  it("syncs document title when assistantName changes", () => {
    const host = createHost();
    host.assistantName = "Tony";
    const changed = new Map<PropertyKey, unknown>([["assistantName", "OpenClaw"]]);

    handleUpdated(host as unknown as Parameters<typeof handleUpdated>[0], changed);

    expect(document.title).toBe("OpenClaw \u2014 Tony");
  });

  it("does not change title when assistantName is not in changed map", () => {
    document.title = "Original";
    const host = createHost();
    host.assistantName = "Tony";
    const changed = new Map<PropertyKey, unknown>([["chatLoading", true]]);

    handleUpdated(host as unknown as Parameters<typeof handleUpdated>[0], changed);

    expect(document.title).toBe("Original");
  });
});
