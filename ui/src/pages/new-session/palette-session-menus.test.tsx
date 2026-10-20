import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
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

function pressKey(target: HTMLElement, key: "ArrowDown" | "ArrowUp" | "Escape") {
  target.focus();
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function expectArrow(target: HTMLElement, key: "ArrowDown" | "ArrowUp", destination: HTMLElement) {
  pressKey(target, key);
  expect(document.activeElement).toBe(destination);
}

function get(root: Pick<ParentNode, "querySelector">, selector: string) {
  return expectDefined(root.querySelector<HTMLElement>(selector), selector);
}

async function openSettings(host: Pick<ParentNode, "querySelector">) {
  get(host, ".palette-session-settings__trigger").click();
  const settings = get(host, ".palette-session-settings");
  await waitForSolid(() => expect(settings.matches(":popover-open")).toBe(true));
  return settings;
}

it("keeps agent navigation and Escape inside the nested menu", async () => {
  const { host } = await mount({
    agents: [
      { id: "main", workspace: "/workspace" },
      { id: "other", workspace: "/other" },
    ],
  });
  const settings = await openSettings(host);
  await waitForSolid(() =>
    expect(host.querySelector(".palette-session-settings__workspace")).not.toBeNull(),
  );
  const workspace = get(host, ".palette-session-settings__workspace");
  const trigger = get(host, ".agent-select__trigger");
  const remember = expectDefined(
    host.querySelector<HTMLInputElement>(".palette-session-settings__remember input"),
    "remember checkbox",
  );
  expect(remember.disabled).toBe(true);
  expectArrow(workspace, "ArrowDown", trigger);

  trigger.click();
  const menu = get(host, ".agent-select__menu");
  await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(true));
  const first = get(menu, '[data-value="option:main"]');
  const last = get(menu, '[data-value="option:other"]');
  expectArrow(workspace, "ArrowUp", last);
  pressKey(last, "ArrowDown");
  await waitForSolid(() => expect(document.activeElement).toBe(first));
  expect(menu.matches(":popover-open")).toBe(true);
  expect(settings.matches(":popover-open")).toBe(true);
  pressKey(first, "Escape");
  await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(false));
  expect(settings.matches(":popover-open")).toBe(true);
  expect(document.activeElement).toBe(trigger);
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
  await openSettings(host);
  await waitForSolid(() =>
    expect(host.querySelector("[data-required-placement] button")).not.toBeNull(),
  );
  const options = expectDefined(host.draft.settingsView(), "palette settings").options;
  options.preferences.failed = true;
  options.onChange();
  await host.updateComplete;
  const placementRetry = get(host, "[data-required-placement] button");
  const preferenceRetry = get(host, ".palette-session-settings__error button");
  const trigger = get(host, ".agent-select__trigger");
  expectArrow(placementRetry, "ArrowDown", preferenceRetry);

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
  const replacementRetry = get(host, "[data-required-placement] button");
  expectArrow(replacementRetry, "ArrowDown", preferenceRetry);

  options.preferences.failed = false;
  options.onChange();
  await host.updateComplete;
  expectArrow(replacementRetry, "ArrowDown", trigger);
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
  await openSettings(host);
  const retry = get(host, ".palette-session-settings__error button");
  await waitForSolid(() =>
    expect(host.querySelector(".palette-session-settings__workspace")).not.toBeNull(),
  );
  get(host, ".palette-session-settings__workspace").click();
  await waitForSolid(() =>
    expect(host.querySelector('[data-machine="local"][data-project="alpha"]')).not.toBeNull(),
  );
  await waitForSolid(() =>
    expect(host.querySelector('[data-machine="runtime:hosted"]')).not.toBeNull(),
  );
  const content = get(host, ".palette-session-settings__content");
  const back = get(content, ".palette-session-settings__back");
  const search = expectDefined(
    content.querySelector<HTMLInputElement>(".palette-session-settings__search"),
    "settings search",
  );
  const connect = get(content, ":scope > .palette-session-settings__row");
  const unavailable = expectDefined(
    content.querySelector<HTMLButtonElement>('[data-machine="runtime:hosted"]'),
    "unavailable machine",
  );
  const alpha = get(content, '[data-machine="local"][data-project="alpha"]');
  const beta = get(content, '[data-machine="local"][data-project="beta"]');
  expect(unavailable.getAttribute("aria-disabled")).toBe("true");
  expect(unavailable.disabled).toBe(false);
  expectArrow(search, "ArrowDown", unavailable);
  expectArrow(alpha, "ArrowDown", beta);
  expectArrow(beta, "ArrowDown", connect);
  expectArrow(connect, "ArrowDown", retry);
  expectArrow(retry, "ArrowDown", back);

  search.value = "Beta";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await host.updateComplete;
  expectArrow(search, "ArrowDown", beta);
  search.value = "";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await host.updateComplete;
  const restoredAlpha = get(content, '[data-machine="local"][data-project="alpha"]');
  expectArrow(beta, "ArrowUp", restoredAlpha);
});
