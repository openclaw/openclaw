/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { configSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createConfigRouteContext, mountConfigPage } from "./config-page.test-support.ts";
import { createTalkMutationHarness } from "./talk.test-support.tsx";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each([
  { mode: "stt-tts", capabilities: ["talk-chat-settings"], visible: true, prefix: "Talk reply " },
  { mode: "stt-tts", capabilities: [], visible: false, prefix: "" },
  { mode: "realtime", capabilities: [], visible: true, prefix: "" },
])(
  "renders reply settings as appropriate for $mode with $capabilities",
  async ({ mode, capabilities, visible, prefix }) => {
    const { page } = createTalkMutationHarness({ serverCapabilities: capabilities });
    page.configObject = { talk: { realtime: { mode, brain: "none" } } };
    await waitForSolid(() => {
      const picker = page.querySelector<HTMLSelectElement>('select[aria-label="Mode"]');
      expect(picker?.value).toBe(mode);
      const rows = [...page.querySelectorAll("select")].filter((row) =>
        /^(Talk reply )?(Thinking level|Fast mode)$/i.test(row.getAttribute("aria-label") ?? ""),
      );
      expect(rows).toHaveLength(visible ? 2 : 0);
      for (const row of rows) {
        expect(row.getAttribute("aria-label")?.startsWith("Talk reply ")).toBe(Boolean(prefix));
        expect(row.disabled).toBe(mode === "realtime");
      }
    });
  },
);

it.each(["realtime", "stt-tts"])("reveals the inline voice ID in %s mode", async (mode) => {
  const context = createConfigRouteContext();
  const config = { talk: { realtime: { mode, speakerVoiceId: "legacy-voice" } } };
  Object.assign(context.runtimeConfig.state, {
    configSnapshot: configSnapshot(config),
    configForm: config,
    configSchema: {
      type: "object",
      properties: {
        talk: {
          type: "object",
          properties: {
            realtime: { type: "object", properties: { speakerVoiceId: { type: "string" } } },
          },
        },
      },
    },
    configUiHints: { "talk.realtime.speakerVoiceId": { advanced: true } },
  });
  const { page: container } = mountConfigPage(context, { pageId: "talk" });
  const summary = await waitForSolid(() => {
    const row = [...container.querySelectorAll("summary")].find(
      (candidate) => candidate.textContent?.trim() === "Advanced",
    );
    expect(row).toBeDefined();
    return row!;
  });
  const scroll = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: mode === "realtime" })),
  );
  try {
    Object.assign(summary.nextElementSibling!, { scrollIntoView: scroll });
    summary.click();
    await waitForSolid(() => {
      const disclosure = summary.parentElement!;
      expect(disclosure.querySelector(".config-advanced-disclosure")).toBeNull();
      expect(
        [...disclosure.querySelectorAll("input")].find((input) => input.value === "legacy-voice"),
      ).toBeDefined();
      expect(scroll).toHaveBeenCalledWith({
        block: "nearest",
        behavior: mode === "realtime" ? "instant" : "smooth",
      });
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
