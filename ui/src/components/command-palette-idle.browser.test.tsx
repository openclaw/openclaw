import { expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import {
  createContext,
  createGateway,
  createSessionResult,
  mountPalette,
} from "./command-palette.test-support.ts";
import "./command-palette.tsx";
import "../styles.css";

it("keeps an idle search settled across usage updates and still accepts command changes", async () => {
  let skillName = "zzidlequery old skill";
  let modelName = "zzidlequery old model";
  const request = vi.fn(async (method: string) => {
    if (method === "skills.status") {
      return { skills: [{ skillKey: "idle", name: skillName, description: "Command" }] };
    }
    if (method === "models.list") {
      return { models: [{ provider: "fixture", id: "idle", name: modelName }] };
    }
    if (method === "plugins.list") {
      return { plugins: [{ id: "idle", name: "zzidlequery plugin", description: "Tools" }] };
    }
    if (method === "sessions.search") {
      return { results: [], sessions: [], archivedTranscriptsExcluded: 146 };
    }
    return { models: [], plugins: [] };
  });
  const harness = createGateway(true, {
    methods: ["skills.status", "models.list", "plugins.list", "sessions.search"],
    request,
  });
  const roster = createSessionResult("agent:main:fixture", "Fixture session");
  roster.sessions = [];
  const list = vi.fn(async () => roster);
  const { palette, provider } = await mountPalette(createContext(harness.gateway, list));
  onTestFinished(() => {
    provider.remove();
    vi.useRealTimers();
  });
  palette.openPalette();
  await palette.updateComplete;
  // Browser keyboard round trips must not advance the search debounce between keys.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const input = palette.querySelector<HTMLTextAreaElement>("textarea")!;
  input.focus();
  await userEvent.keyboard("zzidlequery");
  await vi.advanceTimersByTimeAsync(200);
  await expect
    .poll(() => palette.textContent)
    .toContain("Archived sessions are not included in message search.");
  await expect.poll(() => palette.textContent).not.toMatch(/Searching (commands|sessions)/);
  expect(palette.textContent).toContain("zzidlequery old skill");
  expect(palette.textContent).toContain("zzidlequery old model");
  expect(palette.textContent).toContain("zzidlequery plugin");
  const initialReads = request.mock.calls.length;
  for (let update = 0; update < 3; update++) {
    harness.emit("chat.metadata.changed", {
      modelCatalogChanged: false,
      authChanged: false,
      commandsChanged: false,
    });
    await vi.advanceTimersByTimeAsync(200);
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
  skillName = "zzidlequery skill";
  harness.emit("chat.metadata.changed", { modelCatalogChanged: false, authChanged: false });
  await expect.poll(() => request.mock.calls.length).toBeGreaterThan(initialReads);

  await expect.poll(() => palette.textContent).toContain("zzidlequery skill");
  expect(palette.textContent).not.toContain("zzidlequery old skill");
  expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(1);
  expect(palette.textContent).toContain("zzidlequery old model");
  const refreshedReads = request.mock.calls.length;
  modelName = "zzidlequery new model";
  harness.emit("chat.metadata.changed", {
    modelCatalogChanged: true,
    commandsChanged: false,
    authChanged: false,
  });
  await expect.poll(() => palette.textContent).toContain(modelName);
  expect(palette.textContent).not.toContain("zzidlequery old model");
  expect(palette.textContent).toContain("zzidlequery skill");
  expect(palette.textContent).toContain("zzidlequery plugin");
  expect(request.mock.calls).toHaveLength(refreshedReads + 1);
});
