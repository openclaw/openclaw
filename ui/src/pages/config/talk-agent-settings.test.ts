/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
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
