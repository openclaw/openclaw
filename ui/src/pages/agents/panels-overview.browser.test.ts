import { createComponent, flush } from "solid-js";
import { afterEach, assert, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { disposeSidebarContextLifecycles } from "../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createSessions } from "../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid as mountWithContext } from "../../test-helpers/mount-solid.ts";
import { choosePickerValue, openPicker } from "../../test-helpers/select-picker.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { createAgentConfigActions } from "./agent-config-actions.ts";
import { createAgentViewTestProps, primaryModelPicker } from "./agents-view.test-helpers.ts";
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
  const openFilePicker = vi.spyOn(input, "click").mockImplementation(() => {});
  const button = nativeButton("Choose image…");
  button.focus();
  expect(document.activeElement).toBe(button);
  await userEvent.keyboard("{Enter} ");
  expect(openFilePicker).toHaveBeenCalledTimes(2);

  mounted.update({ ...props, access: { ...props.access, canUpdateIdentity: false } });
  expect(button.disabled).toBe(true);
  button.click();
  expect(openFilePicker).toHaveBeenCalledTimes(2);
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

it.each(["alpha", "beta"])(
  "shows inheritance after clearing %s's primary without changing defaults or fallbacks",
  async (agentId) => {
    const defaults = {
      model: { primary: "fixture/default", fallbacks: ["fixture/global-fallback"] },
      models: { "fixture/default": {}, "fixture/override": {}, "fixture/local-fallback": {} },
    };
    const sourceConfig = {
      agents: {
        defaults,
        entries: {
          [agentId]: {
            model: { primary: "fixture/override", fallbacks: ["fixture/local-fallback"] },
          },
        },
      },
    };
    const request = vi.fn(async () => ({
      sourceConfig,
      hash: "fixture-hash",
      valid: true,
      issues: [],
    }));
    const runtimeConfig = createRuntimeConfigCapability({
      snapshot: {
        client: createTestGatewayClient(request),
        phase: "connected",
        sessionKey: "main",
      },
      subscribe: () => () => {},
    });
    onTestFinished(() => runtimeConfig.dispose());
    await runtimeConfig.ensureLoaded();
    const actions = createAgentConfigActions({
      getRuntimeConfig: () => runtimeConfig,
      getReport: () => null,
      canUpdate: (id) => id === agentId,
      onPrimaryChanged: () => {},
    }).models;
    const props = createAgentViewTestProps({ selectedAgentId: agentId });
    const currentProps = () => ({
      ...props,
      config: runtimeConfig.state,
      overview: { ...props.overview, ...actions },
    });
    const container = createContainer();
    const mounted = mountSolid(Agents, currentProps(), container);
    onTestFinished(runtimeConfig.subscribe(() => mounted.update(currentProps())));
    const picker = primaryModelPicker(container);
    assert(picker, "Missing primary model picker");
    await openPicker(picker);
    expect(picker.querySelector('[aria-selected="true"]')?.getAttribute("data-value")).toBe(
      "fixture/override",
    );
    await choosePickerValue(picker, "");
    expect(runtimeConfig.state.configForm).toEqual({
      agents: {
        defaults,
        entries: { [agentId]: { model: { fallbacks: ["fixture/local-fallback"] } } },
      },
    });
    await openPicker(picker);
    const selected = picker.querySelector('[role="option"][aria-selected="true"]');
    expect(selected?.getAttribute("data-value")).toBe("");
    expect(selected?.textContent?.trim()).toBe("Inherit default (fixture/default)");
    await choosePickerValue(picker, "fixture/default");
    expect(runtimeConfig.state.configForm).toEqual({
      agents: {
        defaults,
        entries: {
          [agentId]: {
            model: { primary: "fixture/default", fallbacks: ["fixture/local-fallback"] },
          },
        },
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
  },
);

function renderModelView(overrides: Partial<Parameters<typeof Agents>[0]>, container: HTMLElement) {
  mountSolid(Agents, createAgentViewTestProps(overrides), container);
}

function config(configForm: Record<string, unknown>) {
  return { ...createAgentViewTestProps().config, configForm };
}

it.each(["alpha", "beta"])("shows inheritance without a shared primary for %s", async (agentId) => {
  const container = createContainer();
  renderModelView(
    { selectedAgentId: agentId, config: config({ agents: { entries: {} } }) },
    container,
  );

  const picker = primaryModelPicker(container);
  await openPicker(picker!);
  const selected = picker?.querySelector('[role="option"][aria-selected="true"]');
  expect(selected?.getAttribute("data-value")).toBe("");
  expect(selected?.textContent?.trim()).toBe("Inherit default");
});

it("keeps restricted model choices independent of private config", async () => {
  const container = createContainer();
  renderModelView(
    {
      selectedAgentId: "alpha",
      config: config({
        agents: {
          defaults: { model: "private/default" },
          entries: { alpha: { model: "private/override" } },
        },
      }),
      overview: {
        ...createAgentViewTestProps().overview,
        modelSelectionPolicy: { restricted: true, defaultModel: "fixture/allowed" },
      },
    },
    container,
  );

  const picker = primaryModelPicker(container);
  expect(picker?.textContent).not.toContain("private/");
  expect(picker?.querySelector(".picker-select__trigger")?.textContent).toContain(
    "Inherit default (fixture/allowed)",
  );
  expect(picker?.querySelector<HTMLButtonElement>(".picker-select__trigger")?.disabled).toBe(true);
});
