import { createComponent, flush } from "solid-js";
import { afterEach, assert, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { disposeSidebarContextLifecycles } from "../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createSessions } from "../../test-helpers/app-sidebar.ts";
import { mountSolid as mountWithContext } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import { Agents } from "./view.tsx";

afterEach(() => vi.restoreAllMocks());

function createContainer() {
  const container = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => container.remove());
  return container;
}

function nativeButton(name: string) {
  const element = page.getByRole("button", { name, exact: true }).element();
  assert(element instanceof HTMLButtonElement, "Expected a native button");
  return element;
}

it("opens agent avatar selection from the keyboard and respects the busy state", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  onTestFinished(() => page.viewport(viewport.width, viewport.height));
  await page.viewport(1365, 900);
  const container = createContainer();
  container.style.cssText = "position:fixed;inset:0;overflow:auto";
  const props = createAgentViewTestProps();
  const mounted = mountSolid(Agents, props, container);
  const avatarButton = nativeButton("Edit avatar");
  avatarButton.focus();
  await userEvent.keyboard("{Enter}");
  expect(avatarButton.getAttribute("aria-expanded")).toBe("true");
  expect(avatarButton.hasAttribute("title")).toBe(false);
  const popover = container.querySelector(".agent-identity-editor__popover");
  expect(popover?.matches(":popover-open")).toBe(true);
  await vi.waitFor(() => expect(popover?.getBoundingClientRect().width).toBeGreaterThan(0));
  const anchor = avatarButton.getBoundingClientRect();
  const fields = container.querySelector(".agent-identity-editor__fields")!.getBoundingClientRect();
  const midpoint = (rect: DOMRect) => rect.top + rect.height / 2;
  expect(Math.abs(midpoint(anchor) - midpoint(fields))).toBeLessThanOrEqual(1);
  // Opening the native popover can precede its anchor layout on a busy browser.
  await vi.waitFor(() => {
    const bounds = popover!.getBoundingClientRect();
    expect(bounds.width).toBeLessThanOrEqual(480);
    const beside = bounds.left >= anchor.right - 1 || bounds.right <= anchor.left + 1;
    const verticalGap = [bounds.top - anchor.bottom, anchor.top - bounds.bottom];
    expect(beside || verticalGap.some((gap) => gap >= -1 && gap <= 20)).toBe(true);
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
  });
  const buttons = popover!.querySelectorAll("button");
  expect(Array.from(buttons, (button) => button.textContent?.trim())).not.toContain("Reset");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  assert(input, "Missing avatar file input");
  const openPicker = vi.spyOn(input, "click").mockImplementation(() => {});
  const button = nativeButton("Choose image…");
  button.focus();
  expect(document.activeElement).toBe(button);
  await userEvent.keyboard("{Enter} ");
  expect(openPicker).toHaveBeenCalledTimes(2);

  mounted.update({ ...props, access: { ...props.access, canUpdateIdentity: false } });
  expect(button.disabled).toBe(true);
  button.click();
  expect(openPicker).toHaveBeenCalledTimes(2);
  await userEvent.keyboard("{Escape}");
  expect(popover?.matches(":popover-open")).toBe(false);
});

it("keeps avatar editing usable when upload policy changes without remounting", async () => {
  const container = createContainer();
  const context = createContext(createApplicationGateway().gateway, createSessions("beta", []));
  onTestFinished(disposeSidebarContextLifecycles);
  const fetchConfig = vi.spyOn(globalThis, "fetch");
  const setUploadsEnabled = async (enabled: boolean) => {
    fetchConfig.mockResolvedValueOnce(Response.json({ uploadsEnabled: enabled }));
    await context.config.refresh();
    flush();
  };
  await setUploadsEnabled(false);
  const { wrapper } = createSolidApplicationContextProvider(context);
  mountWithContext(() => createComponent(Agents, createAgentViewTestProps()), {
    container,
    wrapper,
  });
  const editAvatar = page.getByRole("button", { name: "Edit avatar", exact: true });
  const avatarButton = editAvatar.element();
  await expect.element(editAvatar).toBeDisabled();
  for (const enabled of [true, false, true]) {
    await setUploadsEnabled(enabled);
    expect(editAvatar.element()).toBe(avatarButton);
    await (enabled ? editAvatar.click() : expect.element(editAvatar).toBeDisabled());
    const popover = container.querySelector(".agent-identity-editor__popover");
    expect(popover?.matches(":popover-open")).toBe(enabled);
  }
});
