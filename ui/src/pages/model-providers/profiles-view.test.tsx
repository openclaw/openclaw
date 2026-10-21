/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { ModelProviderCard } from "./data.ts";
import {
  ProviderAccountSummary,
  ProviderProfiles,
  type ProviderProfilesViewProps,
} from "./profiles-view.tsx";
import { card as viewCard, props as makeViewProps } from "./view.test-support.tsx";

function makeProfile(profileId: string): ModelProviderCard["profiles"][number] {
  return { profileId, type: "oauth", status: "ok" };
}
function card(overrides: Partial<ModelProviderCard> = {}) {
  return viewCard({ apiKey: undefined, ...overrides });
}
function orderedCard(
  orders: ModelProviderCard["profileOrders"],
  overrides: Partial<ModelProviderCard> = {},
) {
  const entries = Object.entries(orders).flatMap(([owner, ids]) => ids.map((id) => [id, owner]));
  return card({
    profiles: entries.map(([id]) => makeProfile(id!)),
    profileProviderIds: Object.fromEntries(entries),
    profileOrders: orders,
    ...overrides,
  });
}
const pair = { openai: ["openai:one", "openai:two"] };
const gripSelector = ".model-providers__profile-grip";
const rowSelector = ".model-providers__profile";
function rowFor(container: ParentNode, id: string) {
  return container.querySelector<HTMLElement>(`[data-profile-id="${id}"]`)!;
}

function props(overrides: Partial<ProviderProfilesViewProps> = {}): ProviderProfilesViewProps {
  return {
    ...makeViewProps(),
    onAddAccount: () => undefined,
    addAccountDisabled: false,
    ...overrides,
  };
}

function mount(providerCard: ModelProviderCard, viewProps = props()) {
  const [current, setCurrent] = createSignal({ card: providerCard, props: viewProps });
  const view = mountSolid(() => <ProviderProfiles {...current().props} card={current().card} />);
  const update = (nextCard: ModelProviderCard, nextProps = viewProps) => {
    setCurrent({ card: nextCard, props: nextProps });
    flush();
  };
  flush();
  return { container: view.container, update };
}

function reorderCard() {
  const result = orderedCard(
    {
      "credential-owner": ["account:one", "account:two", "account:three"],
      "other-owner": ["account:other"],
    },
    { id: "route-one" },
  );
  result.profiles = result.profiles.map((profile) => ({
    ...profile,
    email: `${profile.profileId.split(":")[1]}@example.com`,
  }));
  return result;
}

function pointer(target: Element, type: string, coordinates = { x: 20, y: 75 }) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: coordinates.x,
    clientY: coordinates.y,
  });
  Object.defineProperty(event, "pointerId", { value: 7 });
  target.dispatchEvent(event);
}

function pointerFixture(viewProps: ProviderProfilesViewProps) {
  const providerCard = reorderCard();
  const { container, update } = mount(providerCard, viewProps);
  const grip = container.querySelector<HTMLButtonElement>(gripSelector)!;
  const target = rowFor(container, "account:three");
  // Different row heights occur when account metadata wraps on narrow screens.
  let top = 0;
  const rows = [...container.querySelectorAll<HTMLElement>(rowSelector)];
  for (const [index, row] of rows.entries()) {
    const height = [80, 120, 100, 100][index]!;
    const bounds = new DOMRect(0, top, 100, height);
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => {
      const offset = Number.parseFloat(row.style.translate.split(" ")[1] ?? "0");
      return new DOMRect(0, bounds.top + offset, 100, height);
    });
    top += height;
  }
  const hitTest = vi.fn((): Element | null => target);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hitTest });
  const row = grip.closest<HTMLElement>(rowSelector)!;
  return { container, update, grip, row, rows, target, hitTest, providerCard };
}

beforeEach(() => i18n.setLocale("en"));

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "elementFromPoint");
});

it("retains account summary focus while refreshed snapshots update account data and recovery", () => {
  const profileId = "account:shared";
  const cards = [
    card({
      id: "route-one",
      profiles: [{ ...makeProfile(profileId), source: "saved", email: "one@example.invalid" }],
      profileProviderIds: { [profileId]: "owner-one" },
      apiKey: { source: "env", envVar: "EXAMPLE_API_KEY" },
    }),
    card({
      id: "route-two",
      profiles: [{ ...makeProfile(profileId), source: "saved", email: "two@example.invalid" }],
      profileProviderIds: { [profileId]: "owner-two" },
    }),
  ];
  const originalUse = vi.fn();
  const [current, setCurrent] = createSignal({
    cards,
    recovery: { authProvider: "owner-one", disabled: false, onUse: originalUse },
  });
  const { container } = mountSolid(() => <ProviderAccountSummary {...current()} />);
  flush();
  const rows = [...container.querySelectorAll(".model-provider-login__account")];
  expect(rows).toHaveLength(2);
  const button = rows[0]!.querySelector<HTMLButtonElement>("[data-models-use-account]")!;
  expect(rows[1]!.querySelector("[data-models-use-account]")).toBeNull();
  button.focus();

  const refreshed = structuredClone(cards);
  refreshed[0]!.profiles[0]!.email = "updated-one@example.invalid";
  refreshed[0]!.catalogStatus = "auth-rejected";
  refreshed[0]!.apiKey = { source: "config" };
  refreshed[1]!.profiles[0]!.email = "updated-two@example.invalid";
  const latestUse = vi.fn();
  setCurrent({
    cards: refreshed,
    recovery: { authProvider: "owner-one", disabled: false, onUse: latestUse },
  });
  flush();

  const updatedRows = [...container.querySelectorAll(".model-provider-login__account")];
  expect(updatedRows[0]).toBe(rows[0]);
  expect(updatedRows[1]).toBe(rows[1]);
  expect(rows[0]!.textContent).toContain("updated-one@example.invalid");
  expect(rows[0]!.textContent).toContain("Credentials configured");
  expect(rows[1]!.textContent).toContain("updated-two@example.invalid");
  expect(container.querySelector("p.muted")?.textContent).toBe("API key set in config");
  expect(container.textContent).not.toContain("EXAMPLE_API_KEY");
  expect(rows[0]!.querySelector("[data-models-use-account]")).toBe(button);
  expect(document.activeElement).toBe(button);
  button.click();
  expect(latestUse).toHaveBeenCalledExactlyOnceWith(profileId);
  expect(originalUse).not.toHaveBeenCalled();
});

it("shows account provenance and removes drag handles for config-locked priority", () => {
  const onProfileOrderChange = vi.fn();
  const providerCard = orderedCard(
    {
      "openai-config": ["openai:configured", "openai:codex"],
      openai: ["openai:saved", "openai:inherited"],
    },
    { profileOrderLocks: { "openai-config": "provider-config" } },
  );
  const sources = ["config", "external", "saved", "inherited"] as const;
  providerCard.profiles.forEach((profile, index) => {
    profile.source = sources[index]!;
  });
  providerCard.profiles[1]!.displayName = "Codex import";
  providerCard.profileOrders["openai-config"] = ["openai:configured"];

  mount(providerCard, props({ onProfileOrderChange }));

  expect(document.querySelectorAll(gripSelector)).toHaveLength(2);
  for (const id of ["openai:configured", "openai:codex"]) {
    expect(rowFor(document, id).querySelector(gripSelector)).toBeNull();
  }
  expect(document.querySelector(".model-providers__profile-logout")).toBeNull();
  expect(document.body.textContent).not.toContain("Saved in OpenClaw");
  expect(document.body.textContent).toContain("Provider config");
  expect(document.body.textContent).toContain("Codex import");
  expect(document.body.textContent).toContain("Shared credential");
  expect(document.body.textContent).toContain("Priority is managed by provider configuration");
  expect(
    [...document.querySelectorAll("button")].map((button) => button.textContent),
  ).not.toContain("Clear custom order");
  expect(onProfileOrderChange).not.toHaveBeenCalled();
});

it.each<[string, ModelProviderCard, string?, number?]>([
  [
    "Priority is managed by auth.order",
    orderedCard(pair, {
      profileOrderLocks: { openai: "auth-config" },
    }),
    "provider configuration",
  ],
  [
    "Clear custom order",
    orderedCard(pair, {
      profileOrders: { openai: ["openai:removed", "openai:one"] },
      profileOrderStoredProviders: ["openai"],
    }),
    undefined,
    2,
  ],
  [
    "Priority is inherited or managed across provider routes",
    orderedCard(
      { "shared-owner": ["shared:one", "shared:two"] },
      {
        id: "route-one",
        profileOrders: { "shared-owner": ["shared:one", "shared:two", "shared:three"] },
      },
    ),
  ],
  [
    "API key from environment (OPENAI_API_KEY)",
    card({
      apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
      profiles: [{ ...makeProfile("openai:oauth"), source: "saved" }],
      profileOrders: { openai: ["openai:oauth"] },
    }),
  ],
])("shows %s and blocks reordering", (message, providerCard, excluded, count = 0) => {
  const onProfileOrderChange = vi.fn();
  const { container } = mount(providerCard, props({ onProfileOrderChange }));
  const grips = [...container.querySelectorAll<HTMLButtonElement>(gripSelector)];
  expect(grips).toHaveLength(count);
  expect(container.textContent).toContain(message);
  if (excluded) {
    expect(container.textContent).not.toContain(excluded);
  }
  if (count) {
    expect(grips.every((grip) => grip.disabled)).toBe(true);
    pointer(grips[0]!, "pointerdown");
    grips[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  }
  expect(onProfileOrderChange).not.toHaveBeenCalled();
});

it.each(["Escape", "pointercancel", "lostpointercapture", "outside-section", "other-owner"])(
  "does not save a %s drag and allows the next drag",
  (ending) => {
    const onProfileOrderChange = vi.fn();
    const { container, grip, row, rows, target, hitTest } = pointerFixture(
      props({ onProfileOrderChange }),
    );
    const exitSettings = vi.fn();
    const settingsShortcut = (event: KeyboardEvent) => event.defaultPrevented || exitSettings();
    document.addEventListener("keydown", settingsShortcut);
    pointer(grip, "pointerdown");
    pointer(grip, "pointermove", { x: 40, y: 285 });
    expect(row.style.translate).toBe("20px 210px");
    if (ending === "Escape") {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      expect(exitSettings).not.toHaveBeenCalled();
    } else if (ending === "outside-section" || ending === "other-owner") {
      const rejectedTarget =
        ending === "other-owner"
          ? rowFor(container, "account:other")
          : document.createElement("div");
      if (ending === "outside-section" && rejectedTarget instanceof HTMLElement) {
        rejectedTarget.className = "model-providers__profile";
        rejectedTarget.dataset.profileId = "account:three";
        rejectedTarget.dataset.profileProvider = "credential-owner";
        document.body.append(rejectedTarget);
      }
      hitTest.mockReturnValue(rejectedTarget);
    } else {
      pointer(grip, ending);
    }
    document.removeEventListener("keydown", settingsShortcut);
    pointer(grip, "pointerup", { x: 40, y: 285 });
    expect(onProfileOrderChange).not.toHaveBeenCalled();
    expect(rows.every((candidate) => candidate.style.translate === "")).toBe(true);

    hitTest.mockReturnValue(target);
    pointer(grip, "pointerdown");
    pointer(grip, "pointermove", { x: 40, y: 285 });
    pointer(grip, "pointerup", { x: 40, y: 285 });
    expect(onProfileOrderChange).toHaveBeenCalledExactlyOnceWith("route-one", "credential-owner", [
      "account:two",
      "account:three",
      "account:one",
    ]);
  },
);

it("releases account usage mounted after its profile row settles", () => {
  const releaseUsage = vi.fn();
  const registerAccountUsage = vi.fn(() => releaseUsage);
  const providerCard = orderedCard(pair);
  for (const profile of providerCard.profiles) {
    profile.type = "api_key";
  }
  const { container, update } = mount(providerCard, props({ registerAccountUsage }));
  const retainedRow = rowFor(container, "openai:one");
  expect(registerAccountUsage).not.toHaveBeenCalled();

  update({
    ...providerCard,
    profiles: [makeProfile("openai:one")],
    profileOrders: { openai: ["openai:one"] },
  });
  expect(rowFor(container, "openai:one")).toBe(retainedRow);
  expect(container.querySelector("openclaw-model-account-usage")).not.toBeNull();
  expect(registerAccountUsage).toHaveBeenCalledTimes(1);
  expect(releaseUsage).not.toHaveBeenCalled();

  update({ ...providerCard, profiles: [], profileOrders: {} });
  expect(container.querySelector("openclaw-model-account-usage")).toBeNull();
  expect(releaseUsage).toHaveBeenCalledTimes(1);
});

it("releases a removed row's drag without handling the next Escape", () => {
  const onProfileOrderChange = vi.fn();
  const { container, update, grip, row, rows, hitTest, providerCard } = pointerFixture(
    props({ onProfileOrderChange }),
  );
  pointer(grip, "pointerdown");
  pointer(grip, "pointermove", { x: 40, y: 285 });
  expect(row.style.translate).toBe("20px 210px");

  update({
    ...providerCard,
    profiles: providerCard.profiles.filter(({ profileId }) => profileId !== row.dataset.profileId),
    profileOrders: {
      ...providerCard.profileOrders,
      "credential-owner": ["account:two", "account:three"],
    },
  });
  expect(row.isConnected).toBe(false);
  expect(rows.every((candidate) => candidate.style.translate === "")).toBe(true);
  expect(container.querySelector(".model-providers__profiles--sorting")).toBeNull();
  hitTest.mockClear();
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  const stopPropagation = vi.spyOn(escape, "stopPropagation");
  document.dispatchEvent(escape);
  pointer(grip, "pointerup", { x: 40, y: 285 });
  expect(escape.defaultPrevented).toBe(false);
  expect(stopPropagation).not.toHaveBeenCalled();
  expect(hitTest).not.toHaveBeenCalled();
  expect(onProfileOrderChange).not.toHaveBeenCalled();
});

it("prevents both pointer and keyboard reordering without write access", () => {
  const onProfileOrderChange = vi.fn();
  const { grip } = pointerFixture(props({ canMutate: false, onProfileOrderChange }));
  expect(grip.disabled).toBe(true);
  pointer(grip, "pointerdown");
  pointer(grip, "pointerup");
  grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(onProfileOrderChange).not.toHaveBeenCalled();
});

it("keeps focus on the drag handle through repeated keyboard moves", async () => {
  const providerCard = reorderCard();
  const onProfileOrderChange = vi.fn(
    (_cardId: string, provider: string, order: string[] | null) => {
      if (!order) {
        throw new Error("Expected an account order");
      }
      viewProps = { ...viewProps, profileOrders: { [provider]: order } };
      queueMicrotask(() => update(providerCard, viewProps));
    },
  );
  let viewProps = props({ onProfileOrderChange });
  const { container, update } = mount(providerCard, viewProps);
  const grip = container.querySelector<HTMLButtonElement>(gripSelector)!;
  grip.focus();
  const details = grip.closest(rowSelector)!.querySelector("details")!;
  details.open = true;
  expect(container.querySelectorAll(".model-providers__profile-position")).toHaveLength(0);
  expect(grip.getAttribute("aria-keyshortcuts")).toBe("ArrowUp ArrowDown");

  for (const order of [
    ["account:two", "account:one", "account:three", "account:other"],
    ["account:two", "account:three", "account:one", "account:other"],
  ]) {
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await waitForSolid(() => {
      expect(
        [...container.querySelectorAll<HTMLElement>(rowSelector)].map(
          (row) => row.dataset.profileId,
        ),
      ).toEqual(order);
      expect(document.activeElement).toBe(grip);
      expect(grip.closest(rowSelector)!.querySelector("details")).toBe(details);
      expect(details).toMatchObject({ open: true });
      expect(container.querySelectorAll(".model-providers__profile-position")).toHaveLength(3);
    });
  }
  grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(onProfileOrderChange).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(grip);
});
