/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { ModelProviderCard } from "./data.ts";
import { ProviderProfiles, type ProviderProfilesViewProps } from "./profiles-view.tsx";
import { card as viewCard } from "./view.test-support.tsx";

function makeProfile(
  profileId: string,
  extra: Partial<ModelProviderCard["profiles"][number]> = {},
): ModelProviderCard["profiles"][number] {
  return { profileId, type: "oauth", status: "ok", ...extra };
}
function card(overrides: Partial<ModelProviderCard> = {}) {
  return viewCard({ apiKey: undefined, ...overrides });
}
function pairedCard(
  owner = "openai",
  prefix = "openai",
  overrides: Partial<ModelProviderCard> = {},
) {
  const ids = ["one", "two"].map((name) => `${prefix}:${name}`);
  return card({
    profiles: ids.map((id) => makeProfile(id)),
    profileProviderIds: Object.fromEntries(ids.map((id) => [id, owner])),
    profileOrders: { [owner]: ids },
    ...overrides,
  });
}
const gripSelector = ".model-providers__profile-grip";
const rowSelector = ".model-providers__profile";
function rowFor(container: ParentNode, id: string) {
  return container.querySelector<HTMLElement>(`[data-profile-id="${id}"]`)!;
}

function props(overrides: Partial<ProviderProfilesViewProps> = {}): ProviderProfilesViewProps {
  return {
    busy: {},
    canMutate: true,
    mutationBlockedReason: null,
    profileOrders: {},
    onAddAccount: () => undefined,
    addAccountDisabled: false,
    onProfileOrderChange: () => undefined,
    onRequestLogout: () => undefined,
    ...overrides,
  };
}

function mount(providerCard: ModelProviderCard, viewProps = props()) {
  const [current, setCurrent] = createSignal({ card: providerCard, props: viewProps });
  const view = mountSolid(() => <ProviderProfiles {...current().props} card={current().card} />);
  const update = (nextCard: ModelProviderCard, nextProps: ProviderProfilesViewProps) => {
    setCurrent({ card: nextCard, props: nextProps });
    flush();
  };
  flush();
  return { container: view.container, update };
}

function reorderCard(): ModelProviderCard {
  return card({
    id: "route-one",
    profiles: ["one", "two", "three", "other"].map((name) => ({
      profileId: `account:${name}`,
      email: `${name}@example.com`,
      type: "oauth",
      status: "ok",
    })),
    profileProviderIds: {
      "account:one": "credential-owner",
      "account:two": "credential-owner",
      "account:three": "credential-owner",
      "account:other": "other-owner",
    },
    profileOrders: {
      "credential-owner": ["account:one", "account:two", "account:three"],
      "other-owner": ["account:other"],
    },
  });
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

describe("renderProviderProfiles", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("shows account provenance and removes drag handles for config-locked priority", () => {
    const onProfileOrderChange = vi.fn();
    const providerCard = card({
      profiles: [
        makeProfile("openai:configured", { source: "config" }),
        makeProfile("openai:codex", { source: "external", displayName: "Codex import" }),
        makeProfile("openai:saved", { source: "saved" }),
        makeProfile("openai:inherited", { source: "inherited" }),
      ],
      profileProviderIds: {
        "openai:configured": "openai-config",
        "openai:codex": "openai-config",
        "openai:saved": "openai",
        "openai:inherited": "openai",
      },
      profileOrders: {
        "openai-config": ["openai:configured"],
        openai: ["openai:saved", "openai:inherited"],
      },
      profileOrderLocks: { "openai-config": "provider-config" },
    });

    mount(providerCard, props({ onProfileOrderChange }));

    expect(document.querySelectorAll(gripSelector)).toHaveLength(2);
    for (const id of ["openai:configured", "openai:codex"]) {
      expect(rowFor(document, id).querySelector(gripSelector)).toBeNull();
    }
    expect(document.querySelector(".model-providers__profile-logout")).toBeNull();
    expect(document.body.textContent).toContain("Provider config");
    expect(document.body.textContent).toContain("Codex import");
    expect(document.body.textContent).not.toContain("Saved in OpenClaw");
    expect(document.body.textContent).toContain("Shared credential");
    expect(document.body.textContent).toContain("Priority is managed by provider configuration");
    expect(
      [...document.querySelectorAll("button")].map((button) => button.textContent),
    ).not.toContain("Clear custom order");
    expect(onProfileOrderChange).not.toHaveBeenCalled();
  });

  it.each<[string, ModelProviderCard, string, number, boolean, string[]]>([
    [
      "auth-config lock",
      pairedCard("openai", "openai", {
        profileOrderLocks: { openai: "auth-config" },
      }),
      "Priority is managed by auth.order",
      0,
      false,
      ["provider configuration"],
    ],
    [
      "stale stored order",
      pairedCard("openai", "openai", {
        profileOrders: { openai: ["openai:removed", "openai:one"] },
        profileOrderStoredProviders: ["openai"],
      }),
      "Clear custom order",
      2,
      true,
      [],
    ],
    [
      "shared cross-route order",
      pairedCard("shared-owner", "shared", {
        id: "route-one",
        profileOrders: { "shared-owner": ["shared:one", "shared:two", "shared:three"] },
      }),
      "Priority is inherited or managed across provider routes",
      0,
      false,
      [],
    ],
    [
      "environment credential with one saved account",
      card({
        apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
        profiles: [makeProfile("openai:oauth", { source: "saved" })],
        profileOrders: { openai: ["openai:oauth"] },
      }),
      "API key from environment (OPENAI_API_KEY)",
      0,
      false,
      [],
    ],
  ])("locks reordering for %s", (_name, providerCard, message, count, disabled, excluded) => {
    const onProfileOrderChange = vi.fn();
    const { container } = mount(providerCard, props({ onProfileOrderChange }));
    const grips = [...container.querySelectorAll<HTMLButtonElement>(gripSelector)];
    expect(grips).toHaveLength(count);
    expect(container.textContent).toContain(message);
    for (const text of excluded) {
      expect(container.textContent).not.toContain(text);
    }
    if (disabled) {
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
      const settingsShortcut = (event: KeyboardEvent) => {
        if (!event.defaultPrevented) {
          exitSettings();
        }
      };
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
      expect(onProfileOrderChange).toHaveBeenCalledExactlyOnceWith(
        "route-one",
        "credential-owner",
        ["account:two", "account:three", "account:one"],
      );
    },
  );

  it("releases a removed row's drag without handling the next Escape", () => {
    const onProfileOrderChange = vi.fn();
    const viewProps = props({ onProfileOrderChange });
    const { container, update, grip, row, rows, hitTest, providerCard } = pointerFixture(viewProps);
    pointer(grip, "pointerdown");
    pointer(grip, "pointermove", { x: 40, y: 285 });
    expect(row.style.translate).toBe("20px 210px");

    update(
      {
        ...providerCard,
        profiles: providerCard.profiles.filter(
          (profile) => profile.profileId !== row.dataset.profileId,
        ),
        profileOrders: {
          ...providerCard.profileOrders,
          "credential-owner": ["account:two", "account:three"],
        },
      },
      viewProps,
    );
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
        expect(details.open).toBe(true);
        expect(container.querySelectorAll(".model-providers__profile-position")).toHaveLength(3);
      });
    }
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(onProfileOrderChange).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(grip);
  });
});
