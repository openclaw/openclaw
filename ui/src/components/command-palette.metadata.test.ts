/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import {
  createContext,
  createGateway,
  enterQuery,
  findPaletteOption,
  mountPalette,
} from "./command-palette.test-support.ts";
import "./command-palette.ts";

it("refreshes open palette skills without reloading unchanged models", async () => {
  vi.useFakeTimers();
  const restoreDialog = installDialogPolyfill();
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
  const harness = createGateway(true, { methods: ["skills.status", "models.list"], request });
  const { palette, provider } = await mountPalette(
    createContext(harness.gateway, async () => null),
  );
  try {
    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Needle old skill")).toBeDefined();
    expect(findPaletteOption(palette, "Needle model")).toBeDefined();

    skillName = "Needle new skill";
    harness.emit("chat.metadata.changed", { modelCatalogChanged: false, authChanged: false });
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;

    expect(findPaletteOption(palette, "Needle new skill")).toBeDefined();
    expect(findPaletteOption(palette, "Needle old skill")).toBeUndefined();
    expect(findPaletteOption(palette, "Needle model")).toBeDefined();
    expect(request.mock.calls.filter(([method]) => method === "skills.status")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(1);
  } finally {
    provider.remove();
    restoreDialog();
    vi.useRealTimers();
  }
});
