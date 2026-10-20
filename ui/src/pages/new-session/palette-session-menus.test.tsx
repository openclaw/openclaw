import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { mount } from "../../test-helpers/palette-session-draft.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

function pressArrow(target: HTMLElement, key: "ArrowDown" | "ArrowUp") {
  target.focus();
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("palette settings menus", () => {
  it("lets the agent menu consume Escape before closing palette settings", async () => {
    const { host } = await mount({
      agents: [
        { id: "main", workspace: "/workspace" },
        { id: "other", workspace: "/other" },
      ],
    });
    host.querySelector<HTMLButtonElement>(".palette-session-settings__trigger")!.click();
    const settings = host.querySelector<HTMLElement>(".palette-session-settings")!;
    await waitForSolid(() => expect(settings.matches(":popover-open")).toBe(true));
    host.querySelector<HTMLButtonElement>(".agent-select__trigger")!.click();
    const menu = host.querySelector<HTMLElement>(".agent-select__menu")!;
    await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(true));

    menu
      .querySelector<HTMLElement>('[role="menuitemradio"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(false));
    expect(settings.matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(host.querySelector(".agent-select__trigger"));
  });

  it("includes the agent menu controls while leaving their navigation with the menu", async () => {
    const { host } = await mount({
      agents: [
        { id: "main", workspace: "/workspace" },
        { id: "other", workspace: "/other" },
      ],
    });
    host.querySelector<HTMLButtonElement>(".palette-session-settings__trigger")!.click();
    const settings = host.querySelector<HTMLElement>(".palette-session-settings")!;
    await waitForSolid(() => expect(settings.matches(":popover-open")).toBe(true));
    await waitForSolid(() =>
      expect(host.querySelector(".palette-session-settings__workspace")).not.toBeNull(),
    );
    const workspace = expectDefined(
      host.querySelector<HTMLButtonElement>(".palette-session-settings__workspace"),
      "workspace button",
    );
    const trigger = expectDefined(
      host.querySelector<HTMLButtonElement>(".agent-select__trigger"),
      "agent trigger",
    );
    const remember = expectDefined(
      host.querySelector<HTMLInputElement>(".palette-session-settings__remember input"),
      "remember checkbox",
    );
    expect(remember.disabled).toBe(true);
    pressArrow(workspace, "ArrowDown");
    expect(document.activeElement).toBe(trigger);

    trigger.click();
    const menu = host.querySelector<HTMLElement>(".agent-select__menu")!;
    await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(true));
    const first = expectDefined(
      menu.querySelector<HTMLButtonElement>('[data-value="option:main"]'),
      "first agent option",
    );
    const last = expectDefined(
      menu.querySelector<HTMLButtonElement>('[data-value="option:other"]'),
      "last agent option",
    );
    pressArrow(workspace, "ArrowUp");
    expect(document.activeElement).toBe(last);
    pressArrow(last, "ArrowDown");
    await waitForSolid(() => expect(document.activeElement).toBe(first));
    expect(menu.matches(":popover-open")).toBe(true);
    expect(settings.matches(":popover-open")).toBe(true);
  });

  it("uses current placement and preference retry controls after their branches change", async () => {
    let required = true;
    let available = false;
    const { host, context } = await mount({
      methods: ["agents.list", "environments.list", "sessions.create"],
      placementPolicy: async () => ({
        sessionPlacement: required
          ? {
              requiredProfile: {
                id: "dedicated",
                ...(available ? { providerId: "device", inference: "worker" } : {}),
              },
            }
          : {},
      }),
    });
    await context.agents.refreshList();
    host.querySelector<HTMLButtonElement>(".palette-session-settings__trigger")!.click();
    const settings = host.querySelector<HTMLElement>(".palette-session-settings")!;
    await waitForSolid(() => expect(settings.matches(":popover-open")).toBe(true));
    await waitForSolid(() =>
      expect(host.querySelector("[data-required-placement] button")).not.toBeNull(),
    );
    const options = expectDefined(host.draft.settingsView(), "palette settings").options;
    options.preferences.failed = true;
    options.onChange();
    await host.updateComplete;
    const placementRetry = expectDefined(
      host.querySelector<HTMLButtonElement>("[data-required-placement] button"),
      "placement retry",
    );
    const preferenceRetry = expectDefined(
      host.querySelector<HTMLButtonElement>(".palette-session-settings__error button"),
      "preference retry",
    );
    const trigger = expectDefined(
      host.querySelector<HTMLButtonElement>(".agent-select__trigger"),
      "agent trigger",
    );
    pressArrow(placementRetry, "ArrowDown");
    expect(document.activeElement).toBe(preferenceRetry);

    available = true;
    await context.agents.refreshList();
    await waitForSolid(() =>
      expect(host.querySelector("[data-required-placement] button")).toBeNull(),
    );
    available = false;
    await context.agents.refreshList();
    await waitForSolid(() =>
      expect(host.querySelector("[data-required-placement] button")).not.toBeNull(),
    );
    const replacementRetry = expectDefined(
      host.querySelector<HTMLButtonElement>("[data-required-placement] button"),
      "replacement placement retry",
    );
    pressArrow(replacementRetry, "ArrowDown");
    expect(document.activeElement).toBe(preferenceRetry);

    options.preferences.failed = false;
    options.onChange();
    await host.updateComplete;
    pressArrow(replacementRetry, "ArrowDown");
    expect(document.activeElement).toBe(trigger);
    required = false;
    await context.agents.refreshList();
    await waitForSolid(() =>
      expect(host.querySelector(".palette-session-settings__workspace")).not.toBeNull(),
    );
  });

  it("keeps filtered choices and unavailable rows in DOM order before the existing footer", async () => {
    const { host } = await mount({
      scopes: ["operator.admin", "operator.read", "operator.write"],
      agents: [{ id: "main", workspace: "/workspace", model: { primary: "example/local" } }],
      methods: ["agents.list", "environments.list", "projects.list", "sessions.create"],
      modelCatalog: async () => ({
        models: [
          {
            id: "local",
            provider: "example",
            name: "Local model",
            available: true,
            agentRuntime: { id: "openclaw", source: "model" },
            runtimeChoices: [
              {
                agentRuntime: {
                  id: "hosted",
                  source: "model",
                  workspaceEnvironment: { kind: "provider-hosted", label: "Hosted" },
                },
                available: false,
                unavailableReason: "missing-auth",
              },
            ],
          },
        ],
      }),
      request: async (method) =>
        method === "projects.list"
          ? {
              projects: [
                { id: "alpha", displayName: "Alpha", repoRoot: "/alpha", source: "registered" },
                { id: "beta", displayName: "Beta", repoRoot: "/beta", source: "registered" },
              ],
            }
          : {},
    });
    const options = expectDefined(host.draft.settingsView(), "palette settings").options;
    options.preferences.failed = true;
    options.onChange();
    host.querySelector<HTMLButtonElement>(".palette-session-settings__trigger")!.click();
    const settings = host.querySelector<HTMLElement>(".palette-session-settings")!;
    await waitForSolid(() => expect(settings.matches(":popover-open")).toBe(true));
    const retry = expectDefined(
      host.querySelector<HTMLButtonElement>(".palette-session-settings__error button"),
      "preference retry",
    );
    await waitForSolid(() =>
      expect(host.querySelector(".palette-session-settings__workspace")).not.toBeNull(),
    );
    host.querySelector<HTMLButtonElement>(".palette-session-settings__workspace")!.click();
    await waitForSolid(() =>
      expect(host.querySelector('[data-machine="local"][data-project="alpha"]')).not.toBeNull(),
    );
    await waitForSolid(() =>
      expect(host.querySelector('[data-machine="runtime:hosted"]')).not.toBeNull(),
    );
    const content = host.querySelector<HTMLElement>(".palette-session-settings__content")!;
    const back = content.querySelector<HTMLButtonElement>(".palette-session-settings__back")!;
    const search = content.querySelector<HTMLInputElement>(".palette-session-settings__search")!;
    const connect = content.querySelector<HTMLButtonElement>(
      ":scope > .palette-session-settings__row",
    )!;
    const unavailable = expectDefined(
      content.querySelector<HTMLButtonElement>('[data-machine="runtime:hosted"]'),
      "unavailable hosted option",
    );
    const alpha = content.querySelector<HTMLButtonElement>(
      '[data-machine="local"][data-project="alpha"]',
    )!;
    const beta = content.querySelector<HTMLButtonElement>(
      '[data-machine="local"][data-project="beta"]',
    )!;
    expect(unavailable.getAttribute("aria-disabled")).toBe("true");
    expect(unavailable.disabled).toBe(false);
    pressArrow(search, "ArrowDown");
    expect(document.activeElement).toBe(unavailable);
    pressArrow(alpha, "ArrowDown");
    expect(document.activeElement).toBe(beta);
    pressArrow(beta, "ArrowDown");
    expect(document.activeElement).toBe(connect);
    pressArrow(connect, "ArrowDown");
    expect(document.activeElement).toBe(retry);
    pressArrow(retry, "ArrowDown");
    expect(document.activeElement).toBe(back);

    search.value = "Beta";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await host.updateComplete;
    pressArrow(search, "ArrowDown");
    expect(document.activeElement).toBe(beta);
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await host.updateComplete;
    const restoredAlpha = expectDefined(
      content.querySelector<HTMLButtonElement>('[data-machine="local"][data-project="alpha"]'),
      "restored project option",
    );
    pressArrow(beta, "ArrowUp");
    expect(document.activeElement).toBe(restoredAlpha);
  });
});
