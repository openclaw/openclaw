import { expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import { Agents } from "./view.tsx";

it("announces Copy ID feedback in a status region", async () => {
  const writeText = vi.fn(async (_text: string) => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const container = document.body.appendChild(document.createElement("div"));
  const view = mountSolid(Agents, createAgentViewTestProps(), container);
  try {
    const copyId = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === t("agents.copyId"),
    );
    copyId?.click();
    await vi.waitFor(() => {
      const statuses = [...container.querySelectorAll('.agents-toolbar-actions [role="status"]')];
      expect(statuses.map((status) => status.textContent)).toContain(t("common.copied"));
    });
    expect(writeText).toHaveBeenCalledOnce();
  } finally {
    view.dispose();
    container.remove();
    vi.unstubAllGlobals();
  }
});
