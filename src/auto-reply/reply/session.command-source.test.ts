import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { initSessionState } from "./test/session.test-support.js";

// mock-isolation: Reset coverage must not initialize live browser-maintenance owners.
vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));

const stateDir = useSessionStoreTempDirs(afterAll, "openclaw-command-source-").make();

it("does not infer commands from Body-only envelopes or flat history", async () => {
  const storePath = path.join(stateDir, "sessions.json");
  const cfg = {
    session: { store: storePath, resetTriggers: ["/new"] },
  } as OpenClawConfig;

  const legacy = await initSessionState({
    ctx: {
      Body: "[Telegram id:456] İpek: /NEW: keep [Q3]\nline 2",
      ChatType: "direct",
      SenderName: "İpek",
      SessionKey: "agent:main:telegram:dm:legacy",
    },
    cfg,
  });
  expect(legacy.resetTriggered).toBe(false);
  expect(legacy.bodyStripped).toBeUndefined();

  const leading = await initSessionState({
    ctx: {
      Body: " \t/new keep [Q3]\nline 2",
      ChatType: "direct",
      SessionKey: "agent:main:telegram:dm:body-leading",
    },
    cfg,
  });
  expect(leading.resetTriggered).toBe(true);
  expect(leading.bodyStripped).toBe("keep [Q3]\nline 2");

  const projected = await initSessionState({
    ctx: {
      RawBody: "[Telegram id:456] İpek: /NEW: keep [Q3]\nline 2",
      CommandBody: "/NEW: keep [Q3]\nline 2",
      ChatType: "direct",
      SenderName: "İpek",
      SessionKey: "agent:main:telegram:dm:projected",
    },
    cfg,
  });
  expect(projected.resetTriggered).toBe(true);
  expect(projected.bodyStripped).toBe("keep [Q3]\nline 2");

  const flatHistory = await initSessionState({
    ctx: {
      Body: [
        "[Chat messages since your last reply - for context]",
        "[Telegram id:123] Other: /new old text",
        "",
        "[Current message - respond to this]",
        "[Telegram id:456] İpek: /new current text",
      ].join("\n"),
      ChatType: "direct",
      SessionKey: "agent:main:telegram:dm:flat-history",
    },
    cfg,
  });
  expect(flatHistory.resetTriggered).toBe(false);
  expect(flatHistory.bodyStripped).toBeUndefined();
});
