import { expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { AgentsPageMenu } from "./agents-page-menu.tsx";

const showToast = vi.hoisted(() => vi.fn());
vi.mock("../../lib/toast.ts", () => ({ showToast }));

function menuProps() {
  return {
    agentId: "alpha",
    defaultLabel: "Set Default",
    defaultDisabled: false,
    pinLabel: "Pin",
    showRefresh: false,
    refreshLabel: "Refresh",
    refreshDisabled: false,
    onSetDefault: vi.fn(),
    onTogglePinned: vi.fn(),
    onRefresh: vi.fn(),
  };
}

const openItems = (container: HTMLElement) => {
  container.querySelector<HTMLButtonElement>(".agents-page-menu__trigger")!.click();
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
};

it("copies the agent ID from the page menu and confirms with a toast", async () => {
  const writeText = vi.fn(async (_text: string) => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const container = document.body.appendChild(document.createElement("div"));
  const view = mountSolid(AgentsPageMenu, menuProps(), container);
  try {
    await vi.waitFor(() => expect(openItems(container).length).toBeGreaterThan(0));
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.trim() === t("agents.copyId"))!
      .click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith({ message: t("common.copied") }));
    expect(writeText).toHaveBeenCalledWith("alpha");
  } finally {
    view.dispose();
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("offers Refresh only where the visible icon is hidden", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const view = mountSolid(AgentsPageMenu, { ...menuProps(), showRefresh: true }, container);
  try {
    await vi.waitFor(() => {
      const labels = openItems(container).map((item) => item.textContent?.trim());
      expect(labels).toContain("Refresh");
    });
  } finally {
    view.dispose();
    container.remove();
  }
});
