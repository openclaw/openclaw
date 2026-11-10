import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { ContextNewSessionAction, renderNewSessionLink } from "./new-session-link.tsx";

it("enables a mounted new-session action when the Gateway connects", () => {
  const source = createApplicationGateway();
  const context = { gateway: source.gateway, basePath: "" } as ApplicationContext;
  const view = mountSolid(() => (
    <ContextNewSessionAction context={context} agentId="main" class="action" />
  ));
  const link = view.getByRole<HTMLAnchorElement>("link");
  expect(link.hasAttribute("href")).toBe(false);
  source.publish({
    ...source.gateway.snapshot,
    phase: "connected",
    client: {} as GatewayBrowserClient,
    hello: {
      type: "hello-ok",
      protocol: 3,
      features: { methods: ["sessions.create"] },
      auth: { role: "operator", scopes: ["operator.admin"] },
    },
  });
  flush();
  expect(link.getAttribute("href")).toBe("/new?agent=main");
  source.publish({ ...source.gateway.snapshot, phase: "reconnecting" });
  flush();
  expect(link.hasAttribute("href")).toBe(false);
});

it("keeps a resident new-session link current as permission and agent change", () => {
  const [disabledReason, setDisabledReason] = createSignal<string | undefined>("Connecting");
  const [agentId, setAgentId] = createSignal("main");
  const open = vi.fn();
  let onOpen: typeof open | undefined = open;
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
      get onOpen() {
        return onOpen;
      },
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

  onOpen = undefined;
  setDisabledReason(undefined);
  flush();
  link.addEventListener(
    "click",
    (event) => {
      expect(event.defaultPrevented).toBe(false);
      event.preventDefault();
    },
    { once: true },
  );
  link.dispatchEvent(new MouseEvent("click", { cancelable: true }));
  expect(open).toHaveBeenCalledOnce();
});
