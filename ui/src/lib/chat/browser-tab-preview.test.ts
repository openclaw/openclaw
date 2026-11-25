import { describe, expect, it } from "vitest";
import { latestBrowserTabCards } from "./browser-tab-preview.ts";
import { extractToolCardsCached } from "./tool-cards.ts";

const route = { target: "host", profile: "managed" } as const;
const tabKey = (targetId = "tab-1") => JSON.stringify(["host", null, "managed", targetId]);
const selected = (revision: string, targetId = "tab-1") => [
  tabKey(targetId),
  { tab: { ...route, targetId }, revision },
];

function browserResult(callId: string, targetId = "tab-1") {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: "browser",
    content: "ok",
    details: { browserTab: { ...route, targetId } },
  };
}

describe("browser tab selection", () => {
  it("retains the empty selection across unrelated receipts and other sessions", () => {
    const empty = latestBrowserTabCards([], []);
    const message = { role: "toolResult", toolName: "exec", content: "complete" };
    expect(latestBrowserTabCards([message], [])).toBe(empty);
    expect(latestBrowserTabCards([], [message])).toBe(empty);
    expect([...latestBrowserTabCards([browserResult("capture")], [])]).toEqual([
      selected("capture"),
    ]);
    expect(latestBrowserTabCards([message], [])).toBe(empty);
    expect(empty.size).toBe(0);
  });

  it("keeps anonymous result revisions stable across reads but distinct across results", () => {
    const message = {
      role: "toolResult",
      toolName: "browser",
      details: { browserTab: { ...route, targetId: "tab-1" } },
    };
    const initial = latestBrowserTabCards([message], []).get(tabKey())?.revision;
    expect(initial).toBeTruthy();
    expect(extractToolCardsCached(message)[0]?.previewRevision).toBe(initial);
    expect(latestBrowserTabCards([message, { ...message }], []).get(tabKey())?.revision).not.toBe(
      initial,
    );
  });

  it("selects only the latest successful completed result, before filtering rows", () => {
    const older = browserResult("old");
    const latest = browserResult("new");
    const other = browserResult("other", "tab-2");
    const failed = { ...browserResult("failed"), isError: true };
    const running = {
      role: "assistant",
      __openclawToolStreamLive: true,
      content: [
        { type: "toolcall", id: "running", name: "browser", arguments: {} },
        { type: "toolresult", id: "running", name: "browser", details: older.details },
      ],
    };
    expect([...latestBrowserTabCards([null, older, latest, other], [failed, running])]).toEqual([
      selected("new"),
      selected("other", "tab-2"),
    ]);
    expect([...latestBrowserTabCards([older], [latest])]).toEqual([selected("new")]);
  });
});
