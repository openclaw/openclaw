/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import {
  expectAbsent,
  expectContent,
  profile as makeProfile,
} from "../../test-helpers/model-providers.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { ModelProviderCard } from "./data.ts";
import {
  ProviderAccountSummary,
  ProviderProfiles,
  type ProviderProfilesViewProps,
} from "./profiles-view.tsx";
import { card as viewCard, props } from "./view.test-support.tsx";
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

function mount(providerCard: ModelProviderCard, viewProps: ProviderProfilesViewProps = props()) {
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
  return orderedCard(
    {
      "credential-owner": ["account:one", "account:two", "account:three"],
      "other-owner": ["account:other"],
    },
    { id: "route-one" },
  );
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

function movePointer(grip: Element) {
  pointer(grip, "pointerdown");
  pointer(grip, "pointermove", { x: 40, y: 285 });
}

function pointerFixture(viewProps: ProviderProfilesViewProps) {
  const providerCard = reorderCard();
  const { container, update } = mount(providerCard, viewProps);
  const grip = container.querySelector<HTMLButtonElement>(gripSelector)!;
  const target = rowFor(container, "account:three");
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

it("reconnects only expired, locally managed OAuth accounts through their credential owner", () => {
  const onReconnect = vi.fn();
  const providerCard = card({
    profiles: [
      { profileId: "xai:expired", type: "oauth", status: "expired", reconnectSupported: true },
    ],
    profileProviderIds: { "xai:expired": "xai" },
  });
  const viewProps = props({ canReconnect: (provider) => provider === "xai", onReconnect });
  const { container, update } = mount(providerCard, viewProps);
  const button = () =>
    container.querySelector<HTMLButtonElement>(".model-providers__profile-reconnect");
  expect(button()?.textContent).toBe("Reconnect");
  button()!.click();
  expect(onReconnect).toHaveBeenCalledWith("xai");
  for (const blocked of [{ canMutate: false }, { reconnectDisabled: true }]) {
    update(providerCard, { ...viewProps, ...blocked });
    expect(button()?.disabled).toBe(true);
  }
  for (const profile of [
    { profileId: "xai:expired", type: "oauth", status: "ok", reconnectSupported: true },
    { profileId: "xai:expired", type: "api_key", status: "expired", reconnectSupported: true },
  ] as const) {
    update({ ...providerCard, profiles: [profile] }, viewProps);
    expect(button()).toBeNull();
  }
  update(providerCard, { ...viewProps, canReconnect: () => false });
  expect(button()).toBeNull();
});

it("retains account summary focus while refreshed snapshots update account data and recovery", () => {
  const profileId = "account:shared";
  const cards = ["one", "two"].map((name) =>
    card({
      id: `route-${name}`,
      profiles: [makeProfile(profileId, { source: "saved", email: `${name}@example.invalid` })],
      profileProviderIds: { [profileId]: `owner-${name}` },
    }),
  );
  cards[0]!.apiKey = { source: "env", envVar: "EXAMPLE_API_KEY" };
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
  expectAbsent(rows[1]!, "[data-models-use-account]");
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
  expectContent(rows[0]!, ["updated-one@example.invalid"]);
  expectContent(rows[0]!, ["Credentials configured"]);
  expectContent(rows[1]!, ["updated-two@example.invalid"]);
  expect(container.querySelector("p.muted")?.textContent).toBe("API key set in config");
  expectContent(container, [], ["EXAMPLE_API_KEY"]);
  expect(rows[0]!.querySelector("[data-models-use-account]")).toBe(button);
  expect(document.activeElement).toBe(button);
  button.click();
  expect(latestUse).toHaveBeenCalledExactlyOnceWith(profileId);
  expect(originalUse).not.toHaveBeenCalled();
});

it("shows account provenance and removes drag handles for config-locked priority", () => {
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

  mount(providerCard);

  expect(document.querySelectorAll(gripSelector)).toHaveLength(2);
  for (const id of ["openai:configured", "openai:codex"]) {
    expectAbsent(rowFor(document, id), gripSelector);
  }
  expectAbsent(document, ".model-providers__profile-logout");
  expectContent(document.body, [], ["Saved in OpenClaw"]);
  expectContent(document.body, ["Provider config"]);
  expectContent(document.body, ["Codex import"]);
  expectContent(document.body, ["Shared credential"]);
  expectContent(document.body, ["Priority is managed by provider configuration"]);
  expect(
    [...document.querySelectorAll("button")].map((button) => button.textContent),
  ).not.toContain("Clear custom order");
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
  expectContent(container, [message]);
  if (excluded) {
    expectContent(container, [], [excluded]);
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
    movePointer(grip);
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
    movePointer(grip);
    pointer(grip, "pointerup", { x: 40, y: 285 });
    expect(onProfileOrderChange).toHaveBeenCalledExactlyOnceWith("route-one", "credential-owner", [
      "account:two",
      "account:three",
      "account:one",
    ]);
  },
);

it("names hidden identities by credential kind, numbering only repeated kinds", () => {
  const { container } = mount(
    card({
      profiles: [
        makeProfile("openai:token-a", { type: "token", status: "static" }),
        makeProfile("openai:oauth"),
        makeProfile("openai:token-b", { type: "token", status: "static" }),
        makeProfile("openai:named", { type: "token", status: "static", email: "ops@example.com" }),
      ],
      profileOrders: {
        openai: ["openai:token-a", "openai:oauth", "openai:token-b", "openai:named"],
      },
    }),
  );
  expect(
    [...container.querySelectorAll(".model-providers__profile-copy strong")].map(
      (identity) => identity.textContent,
    ),
  ).toEqual(["Access token 1", "Signed-in account", "Access token 2", "ops@example.com"]);
});

it("releases a removed row's drag without handling the next Escape", () => {
  const onProfileOrderChange = vi.fn();
  const { container, update, grip, row, rows, hitTest, providerCard } = pointerFixture(
    props({ onProfileOrderChange }),
  );
  movePointer(grip);
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
  expectAbsent(container, ".model-providers__profiles--sorting");
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
  const movedRow = grip.closest(rowSelector)!;
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
      expect(grip.closest(rowSelector)).toBe(movedRow);
      expect(container.querySelectorAll(".model-providers__profile-position")).toHaveLength(3);
    });
  }
  grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(onProfileOrderChange).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(grip);
});

it.each([undefined, "auth-rejected"] as const)(
  "keeps account-level recovery independent of provider outcome %s in both account surfaces",
  (catalogStatus) => {
    const expiring = makeProfile("example:short", {
      status: "expiring",
      expiry: { at: 4_000_000, remainingMs: 3_600_000, label: "1h" },
    });
    const expired = makeProfile("example:elapsed", {
      status: "expired",
      expiry: { at: 1, remainingMs: -1, label: "0m" },
    });
    const fenced = makeProfile("example:reconnect", { status: "expired", reasonCode: "expired" });
    const missing = makeProfile("example:missing", {
      status: "missing",
      reasonCode: "missing_credential",
    });
    const external = makeProfile("example:external", {
      ...expired,
      profileId: "example:external",
      externallyManaged: true,
    });
    const staticToken = makeProfile("example:static", {
      type: "token",
      status: "expired",
      reasonCode: "expired",
    });
    const providerCard = card({
      id: "example",
      catalogStatus,
      profiles: [expiring, expired, fenced, missing, external, staticToken],
    });
    const { container } = mount(providerCard);
    const summary = mountSolid(() => <ProviderAccountSummary cards={[providerCard]} />).container;
    flush();
    for (const root of [container, summary]) {
      expectContent(rowFor(root, expiring.profileId), [
        "Access token expires in 1h",
        "Access-token expiry alone does not mean you need to sign in again.",
      ]);
      expectContent(rowFor(root, expired.profileId), ["Access token expired"], ["Sign in again"]);
      expectContent(rowFor(root, fenced.profileId), ["Sign-in unavailable"], ["Sign in again"]);
      expectContent(rowFor(root, missing.profileId), ["Sign in again"]);
      expectContent(rowFor(root, external.profileId), ["Managed externally"], ["Signed in"]);
      expectContent(
        rowFor(root, staticToken.profileId),
        ["Expired"],
        ["Access-token expiry alone"],
      );
    }
  },
);
