import { createComponent, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { disposeSidebarContextLifecycles } from "../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createSessions } from "../../test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../../test-helpers/solid-application-context.tsx";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import { Agents } from "./view.tsx";

it("opens agent avatar selection from the keyboard and respects the busy state", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  onTestFinished(() => page.viewport(viewport.width, viewport.height));
  await page.viewport(1365, 900);
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;inset:0;overflow:auto";
  document.body.append(container);
  const props = createAgentViewTestProps();
  const mounted = mountSolid(Agents, props, container);
  try {
    const editAvatar = page.getByRole("button", { name: "Edit avatar", exact: true });
    const avatarButton = editAvatar.element();
    if (!(avatarButton instanceof HTMLButtonElement)) {
      throw new Error("Avatar edit affordance must use a native button");
    }
    avatarButton.focus();
    await userEvent.keyboard("{Enter}");
    expect(avatarButton.getAttribute("aria-expanded")).toBe("true");
    expect(avatarButton.hasAttribute("title")).toBe(false);
    const popover = container.querySelector<HTMLElement>(".agent-identity-editor__popover");
    expect(popover?.matches(":popover-open")).toBe(true);
    await vi.waitFor(() => expect(popover?.getBoundingClientRect().width).toBeGreaterThan(0));
    const avatarBounds = avatarButton.getBoundingClientRect();
    const fieldsBounds = container
      .querySelector<HTMLElement>(".agent-identity-editor__fields")!
      .getBoundingClientRect();
    expect(
      Math.abs(
        avatarBounds.top + avatarBounds.height / 2 - (fieldsBounds.top + fieldsBounds.height / 2),
      ),
    ).toBeLessThanOrEqual(1);
    // Opening the native popover can precede its anchor layout on a busy browser.
    await vi.waitFor(() => {
      const popoverBounds = popover!.getBoundingClientRect();
      expect(popoverBounds.width).toBeLessThanOrEqual(480);
      const beside =
        popoverBounds.left >= avatarBounds.right - 1 ||
        popoverBounds.right <= avatarBounds.left + 1;
      const below =
        popoverBounds.top >= avatarBounds.bottom - 1 &&
        popoverBounds.top <= avatarBounds.bottom + 20;
      const above =
        popoverBounds.bottom <= avatarBounds.top + 1 &&
        popoverBounds.bottom >= avatarBounds.top - 20;
      expect(beside || below || above).toBe(true);
      expect(popoverBounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
    });
    expect(
      [...popover!.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Reset",
      ),
    ).toBe(false);
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) {
      throw new Error("Missing avatar file input");
    }
    const openPicker = vi.spyOn(input, "click").mockImplementation(() => {});
    const upload = page.getByRole("button", { name: "Choose image…", exact: true });
    const button = upload.element();
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Avatar upload must use a native button");
    }
    button.focus();
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(openPicker).toHaveBeenCalledTimes(2);

    mounted.update({ ...props, access: { ...props.access, canUpdateIdentity: false } });
    expect(button.disabled).toBe(true);
    button.click();
    expect(openPicker).toHaveBeenCalledTimes(2);
    await userEvent.keyboard("{Escape}");
    expect(popover?.matches(":popover-open")).toBe(false);
  } finally {
    vi.restoreAllMocks();
    mounted.dispose();

    container.remove();
  }
});

it("keeps avatar editing usable when upload policy changes without remounting", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const base = createAgentViewTestProps();
  const context = createContext(createApplicationGateway().gateway, createSessions("beta", []));
  onTestFinished(disposeSidebarContextLifecycles);
  const fetchConfig = vi.spyOn(globalThis, "fetch");
  const setUploadsEnabled = async (enabled: boolean) => {
    fetchConfig.mockResolvedValueOnce(Response.json({ uploadsEnabled: enabled }));
    await context.config.refresh();
    flush();
  };
  await setUploadsEnabled(false);
  const mounted = mountSolid(
    () =>
      createComponent(ApplicationProvider, {
        value: context,
        get children() {
          return createComponent(Agents, base);
        },
      }),
    {},
    container,
  );
  try {
    const editAvatar = page.getByRole("button", { name: "Edit avatar", exact: true });
    const avatarButton = editAvatar.element();
    await expect.element(editAvatar).toBeDisabled();
    await setUploadsEnabled(true);
    await editAvatar.click();
    const popover = container.querySelector<HTMLElement>(".agent-identity-editor__popover");
    expect(popover?.matches(":popover-open")).toBe(true);

    await setUploadsEnabled(false);
    await expect.element(editAvatar).toBeDisabled();
    expect(popover?.matches(":popover-open")).toBe(false);

    await setUploadsEnabled(true);
    expect(editAvatar.element()).toBe(avatarButton);
    await editAvatar.click();
    expect(popover?.matches(":popover-open")).toBe(true);
  } finally {
    fetchConfig.mockRestore();
    mounted.dispose();
    container.remove();
  }
});
