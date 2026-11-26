import { expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { AgentsPageMenu } from "./agents-page-menu.tsx";

function menuProps() {
  return {
    agentId: "alpha",
    canCreateAgent: true,
    canSetDefault: true,
    canDeleteAgent: true,
    defaultLabel: "Set default",
    defaultDisabled: false,
    pinLabel: "Pin",
    deleteDisabled: false,
    onDelete: vi.fn(),
    showPhoneActions: false,
    createLabel: "New agent",
    createDisabled: false,
    onCreate: vi.fn(),
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

it("keeps Copy ID feedback in the menu and permits an immediate retry or next action", async () => {
  const writeText = vi
    .fn(async (_text: string) => undefined)
    .mockRejectedValueOnce(new Error("Clipboard unavailable"));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const container = document.body.appendChild(document.createElement("div"));
  const props = menuProps();
  const view = mountSolid(AgentsPageMenu, props, container);
  try {
    await vi.waitFor(() => expect(openItems(container).length).toBeGreaterThan(0));
    const trigger = container.querySelector<HTMLButtonElement>(".agents-page-menu__trigger")!;
    const copy = document.querySelector<HTMLButtonElement>('[role="menuitem"][data-value="copy"]')!;
    copy.click();
    await vi.waitFor(() =>
      expect(copy.querySelector('[role="status"] .sr-only')?.textContent).toBe(
        t("common.copyFailed"),
      ),
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    copy.click();
    await vi.waitFor(() =>
      expect(copy.querySelector('[role="status"]')?.textContent).toBe(t("common.copied")),
    );
    expect(writeText.mock.calls).toEqual([["alpha"], ["alpha"]]);
    document.querySelector<HTMLButtonElement>('[role="menuitem"][data-value="pin"]')!.click();
    expect(props.onTogglePinned).toHaveBeenCalledWith("alpha");
    trigger.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-value="copy"] [role="status"]')?.textContent).toBe(
        t("agents.copyId"),
      ),
    );
  } finally {
    view.dispose();
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([false, true, "denied"] as const)(
  "handles selected agent deletion from the page menu (%s)",
  async (mode) => {
    const props = {
      ...menuProps(),
      showPhoneActions: mode === true,
      deleteDisabled: mode === "denied",
    };
    const container = document.body.appendChild(document.createElement("div"));
    const view = mountSolid(AgentsPageMenu, props, container);
    try {
      await vi.waitFor(() =>
        expect(
          openItems(container).some((item) => item.textContent?.trim() === t("common.delete")),
        ).toBe(true),
      );
      const deletion = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent?.trim() === t("common.delete"),
      );
      expect(deletion).toBeDefined();
      deletion!.click();
      if (mode === "denied") {
        expect(props.onDelete).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(props.onDelete).toHaveBeenCalledWith("alpha"));
      }
    } finally {
      view.dispose();
      container.remove();
    }
  },
);

it("leads with New agent and adds Refresh on the phone", async () => {
  const onCreate = vi.fn();
  const container = document.body.appendChild(document.createElement("div"));
  const view = mountSolid(
    AgentsPageMenu,
    { ...menuProps(), showPhoneActions: true, onCreate },
    container,
  );
  try {
    await vi.waitFor(() => {
      const labels = openItems(container).map((item) => item.textContent?.trim());
      expect(labels[0]).toBe("New agent");
      expect(labels).toContain("Refresh");
    });
    document.querySelector<HTMLElement>('[role="menuitem"]')!.click();
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
  } finally {
    view.dispose();
    container.remove();
  }
});

it("hides unavailable management actions while retaining personal actions and refresh", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const view = mountSolid(
    AgentsPageMenu,
    {
      ...menuProps(),
      showPhoneActions: true,
      canCreateAgent: false,
      canSetDefault: false,
      canDeleteAgent: false,
    },
    container,
  );
  try {
    await vi.waitFor(() =>
      expect(openItems(container).map((item) => item.textContent?.trim())).toEqual([
        t("agents.copyId"),
        "Pin",
        "Refresh",
      ]),
    );
  } finally {
    view.dispose();
    container.remove();
  }
});

it("leaves New agent and Refresh out of the desktop menu", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const view = mountSolid(AgentsPageMenu, menuProps(), container);
  try {
    await vi.waitFor(() => {
      const labels = openItems(container).map((item) => item.textContent?.trim());
      expect(labels.length).toBeGreaterThan(0);
      expect(labels).not.toContain("New agent");
      expect(labels).not.toContain("Refresh");
    });
  } finally {
    view.dispose();
    container.remove();
  }
});
