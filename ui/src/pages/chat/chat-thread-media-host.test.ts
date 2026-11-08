import { describe, expect, it, onTestFinished, vi } from "vitest";

async function loadCaptionlessIpHistory(paneId: string) {
  vi.resetModules();
  const support = await import("./chat-thread.test-support.ts");
  const message = { ...support.makeMessage("ip-only", 1), content: "MEDIA:https://8.8.8.8/a.png" };
  return support.createProps({ paneId, messages: [message] });
}

describe("transcript rows for media hosts that wait on the IP guard", () => {
  it("rebuilds the mounted transcript source without a history change", async () => {
    const input = await loadCaptionlessIpHistory("media-host-source");
    const solid = await import("solid-js");
    const streamSource = await import("./components/chat-transcript-stream-source.ts");
    // The transcript projection reads the source snapshot inside its own computation.
    const rows = solid.createRoot((dispose) => {
      onTestFinished(dispose);
      return solid.createMemo(
        () => streamSource.createTranscriptStreamSource(input, false).snapshot.items,
      );
    });
    solid.flush();
    expect(rows()).toHaveLength(0);
    await (await import("../../lib/chat/message-normalizer.ts")).loadMediaHostGuard();
    await Promise.resolve();
    solid.flush();
    expect(rows()).toHaveLength(1);
    expect(JSON.stringify(rows())).toContain("https://8.8.8.8/a.png");
  });

  it("reports a failed guard load to the owner of unsaved work that blocks reload", async () => {
    onTestFinished(() => vi.doUnmock("@openclaw/net-policy/ip"));
    // mock-isolation: the guard chunk must fail to load, so no real export may be served.
    vi.doMock("@openclaw/net-policy/ip", () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    });
    const props = await loadCaptionlessIpHistory("media-host-blocked");
    const { buildCachedChatItems } = await import("./chat-thread.ts");
    const guard = await import("../../app/document-reload-guard.ts");
    const onBlocked = vi.fn();
    onTestFinished(guard.registerControlUiReloadGuard(() => false, onBlocked));
    expect(buildCachedChatItems(props)).toHaveLength(0);
    await vi.waitFor(() => expect(onBlocked).toHaveBeenCalledOnce());
    // Validation stays closed: the host is still rejected after the failure.
    expect(buildCachedChatItems(props)).toHaveLength(0);
  });
});
