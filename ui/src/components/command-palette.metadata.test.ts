/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import {
  findPaletteOption,
  mountSearch,
  registerCommandPaletteTestHooks,
  searchPalette,
  settlePalette,
} from "./command-palette.test-support.ts";
import "./command-palette.tsx";

registerCommandPaletteTestHooks({ mockScroll: false });
const model = (id: string) => ({ provider: "ollama", id, name: `Needle ${id}` });

it("refreshes open palette skills without reloading unchanged models", async () => {
  let skillName = "Needle old skill";
  const request = vi.fn(async (method: string) => {
    if (method === "skills.status") {
      return { skills: [{ skillKey: "needle", name: skillName }] };
    }
    if (method === "models.list") {
      return { models: [{ provider: "fixture", id: "needle", name: "Needle model" }] };
    }
    return { results: [], sessions: [] };
  });
  const { palette, emit } = await mountSearch({
    methods: ["skills.status", "models.list"],
    request,
  });
  await searchPalette(palette, "needle");
  expect(findPaletteOption(palette, "Needle old skill")).toBeDefined();
  expect(findPaletteOption(palette, "Needle model")).toBeDefined();

  skillName = "Needle new skill";
  emit("chat.metadata.changed", { modelCatalogChanged: false, authChanged: false });
  await settlePalette(palette, 0);

  expect(findPaletteOption(palette, "Needle new skill")).toBeDefined();
  expect(findPaletteOption(palette, "Needle old skill")).toBeUndefined();
  expect(findPaletteOption(palette, "Needle model")).toBeDefined();
  expect(request.mock.calls.filter(([method]) => method === "skills.status")).toHaveLength(2);
  expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(1);
});

it("keeps returned model rows without refresh warnings or obsolete choices", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ models: [model("retained"), model("obsolete")] })
    .mockResolvedValueOnce({
      models: [model("retained")],
      refreshFailed: true,
      providerOutcomes: [{ provider: "ollama", status: "unavailable" }],
    })
    .mockResolvedValueOnce({
      models: [],
      providerOutcomes: [{ provider: "ollama", status: "ready" }],
    });
  const { palette, emit } = await mountSearch({
    methods: ["models.list"],
    request: (method, params) =>
      method === "models.list" ? request(method, params) : { results: [], sessions: [] },
  });
  await searchPalette(palette, "needle");
  expect(findPaletteOption(palette, "Needle obsolete")).toBeDefined();
  emit("chat.metadata.changed", {
    agentId: "main",
    usageUpdatedAt: 1,
    modelCatalogChanged: false,
    authChanged: false,
  });
  await vi.advanceTimersByTimeAsync(200);
  expect(request).toHaveBeenCalledOnce();

  emit("chat.metadata.changed");
  await settlePalette(palette);
  expect(findPaletteOption(palette, "Needle obsolete")).toBeUndefined();
  expect(palette.querySelectorAll('[role="option"]')).toHaveLength(1);
  expect(findPaletteOption(palette, "Needle retained")).toBeDefined();
  expect(palette.querySelector(".cmd-palette__source-error")).toBeNull();

  emit("chat.metadata.changed");
  await settlePalette(palette);
  expect(findPaletteOption(palette, "Needle retained")).toBeUndefined();
  expect(palette.querySelector(".cmd-palette__source-error")).toBeNull();
});
