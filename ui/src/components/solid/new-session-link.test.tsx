import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { renderNewSessionLink } from "./new-session-link.tsx";

it("keeps a resident new-session link current as permission and agent change", () => {
  const [disabledReason, setDisabledReason] = createSignal<string | undefined>("Connecting");
  const [agentId, setAgentId] = createSignal("main");
  const open = vi.fn();
  const view = mountSolid(() =>
    renderNewSessionLink({
      basePath: "",
      get agentId() {
        return agentId();
      },
      class: "sidebar-new-session",
      label: "New conversation",
      showShortcut: true,
      get disabledReason() {
        return disabledReason();
      },
      onOpen: open,
    }),
  );
  const link = view.getByRole<HTMLAnchorElement>("link", { name: "New conversation" });
  expect(link.hasAttribute("href")).toBe(false);
  expect(link.tabIndex).toBe(-1);
  expect(view.container.querySelector('[slot="content"]')).toBeNull();
  link.click();
  expect(open).not.toHaveBeenCalled();

  setDisabledReason(undefined);
  setAgentId("research");
  flush();

  expect(view.getByRole("link", { name: "New conversation" })).toBe(link);
  expect(link.getAttribute("href")).toBe("/new?agent=research");
  expect(link.getAttribute("aria-disabled")).toBeNull();
  expect(link.tabIndex).toBe(0);
  expect(view.container.querySelector('[slot="content"] kbd')).not.toBeNull();
  link.focus();
  expect(document.activeElement).toBe(link);
  link.click();
  expect(open).toHaveBeenCalledExactlyOnceWith("research", undefined);

  setDisabledReason("Permission revoked");
  flush();

  expect(link.getAttribute("aria-disabled")).toBe("true");
  expect(link.hasAttribute("href")).toBe(false);
  expect(view.container.querySelector('[slot="content"]')).toBeNull();
  link.click();
  expect(open).toHaveBeenCalledOnce();
});
