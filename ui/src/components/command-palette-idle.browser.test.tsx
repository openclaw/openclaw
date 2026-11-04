import { expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createContext,
  createGateway,
  createSessionResult,
  mountPalette,
} from "./command-palette.test-support.ts";
import "./command-palette.tsx";
import "../styles.css";

it("keeps an idle search settled across usage updates and still accepts command changes", async () => {
  const refresh = createDeferred<{
    skills: { skillKey: string; name: string; description: string }[];
  }>();
  let refreshing = false;
  const request = vi.fn(async (method: string) => {
    if (method === "skills.status") {
      return refreshing ? refresh.promise : { skills: [] };
    }
    if (method === "sessions.search") {
      return { results: [], sessions: [], archivedTranscriptsExcluded: 146 };
    }
    return { models: [], plugins: [] };
  });
  const harness = createGateway(true, {
    methods: ["skills.status", "models.list", "sessions.search"],
    request,
  });
  const roster = createSessionResult("agent:main:fixture", "Fixture session");
  roster.sessions = [];
  const list = vi.fn(async () => roster);
  const { palette, provider } = await mountPalette(createContext(harness.gateway, list));
  onTestFinished(() => provider.remove());
  palette.openPalette();
  await palette.updateComplete;
  const input = palette.querySelector<HTMLTextAreaElement>("textarea")!;
  input.focus();
  await userEvent.keyboard("zzidlequery");
  await expect
    .poll(() => request.mock.calls.filter(([method]) => method === "sessions.search").length)
    .toBe(1);
  await expect
    .poll(() => palette.textContent)
    .toContain("Archived sessions are not included in message search.");
  await expect.poll(() => palette.textContent).not.toMatch(/Searching (commands|sessions)/);
  const initialReads = request.mock.calls.length;
  refreshing = true;
  for (let update = 0; update < 3; update++) {
    harness.emit("chat.metadata.changed", {
      modelCatalogChanged: false,
      authChanged: false,
      commandsChanged: false,
    });
    await palette.updateComplete;
  }
  expect(input.value).toBe("zzidlequery");
  expect(request.mock.calls).toHaveLength(initialReads);
  expect(list).toHaveBeenCalledTimes(1);
  const note = palette.querySelector<HTMLElement>(".cmd-palette__archive-note")!;
  expect(note.closest(".cmd-palette__footer")).not.toBeNull();
  expect(Number.parseFloat(getComputedStyle(note).fontSize)).toBeLessThan(12);
  expect(palette.textContent).not.toContain("Searching commands");
  expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).not.toBe("true");
  expect(request.mock.calls.filter(([method]) => method === "sessions.search")).toHaveLength(1);
  harness.emit("chat.metadata.changed", { modelCatalogChanged: false, authChanged: false });
  await expect.poll(() => request.mock.calls.length).toBeGreaterThan(initialReads);
  refresh.resolve({
    skills: [{ skillKey: "idle", name: "zzidlequery skill", description: "Updated command" }],
  });
  await expect.poll(() => palette.textContent).toContain("zzidlequery skill");
});
