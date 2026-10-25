/* @vitest-environment jsdom */
import { getQueriesForElement } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import * as idleImport from "../../lib/idle-import.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createSidebarTestRouter } from "../../test-helpers/app-sidebar-router.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createSessionOwnerMenuHarness,
  sessionOwnerProfiles,
} from "../../test-helpers/session-owner-menu.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import "./person-reference.tsx";

type PersonReferenceElement = HTMLElementTagNameMap["openclaw-person-reference"];
const hosts: PersonReferenceElement[] = [];
let restoreI18n: ReturnType<typeof captureI18nStateForTesting>;
const queries = (element: HTMLElement = document.body) => getQueriesForElement(element);
const dialog = () => queries().queryByRole("dialog");
const createIdleImport = idleImport.createIdleImport;

async function settle(host?: PersonReferenceElement) {
  await (host?.updateComplete ?? Promise.resolve());
  flush();
}

beforeEach(async () => {
  restoreI18n = captureI18nStateForTesting();
  await i18n.setLocale("en");
});

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    host.remove();
  }
  await settle();
  await restoreI18n();
  flush();
});

async function createReference(
  profileId: string,
  label: string,
  parent: HTMLElement = document.body,
) {
  const host = document.createElement("openclaw-person-reference");
  hosts.push(host);
  host.profileId = profileId;
  host.label = label;
  parent.append(host);
  await settle(host);
  return host;
}

function openReference(host: PersonReferenceElement) {
  const trigger = queries(host).getByRole("button");
  trigger.click();
  flush();
  return { trigger, card: queries().getByRole("dialog") };
}

it("shares the admitted directory read and only resolves the currently open card", async () => {
  const pending = Promise.withResolvers<ReturnType<typeof sessionOwnerProfiles>>();
  const { context: ownerContext, request } = createSessionOwnerMenuHarness(() => pending.promise);
  const context = { ...ownerContext, router: createSidebarTestRouter() };
  const provider = document.createElement("div");
  const view = mountSolid(() => <ApplicationProvider host={provider} value={context} />, {
    container: provider,
  });
  document.body.append(provider);
  try {
    const alice = await createReference("profile-alice", "Alice", provider);
    const bob = await createReference("profile-bob", "Bob", provider);
    const first = openReference(alice);
    const second = openReference(bob);
    expect(first.card.isConnected).toBe(false);
    expect(second.card.getAttribute("aria-label")).toBe("Activity for Bob");
    expect(queries(second.card).getByRole("status").textContent).toBe("Loading…");
    await waitForSolid(() =>
      expect(request.mock.calls.filter(([method]) => method === "users.list")).toHaveLength(1),
    );

    pending.resolve(sessionOwnerProfiles("Alice", "Bob"));
    await waitForSolid(() =>
      expect(queries(second.card).getByRole("heading", { name: "Bob" })).toBeTruthy(),
    );
    expect(dialog()).toBe(second.card);
    expect(first.card.isConnected).toBe(false);
    expect(second.card.getAttribute("aria-label")).toBe("Activity for Bob");
    expect(second.trigger.getAttribute("aria-expanded")).toBe("true");
  } finally {
    provider.remove();
    view.unmount();
    await settle();
  }
});

it("routes label and profile changes to their active mention only", async () => {
  const alice = await createReference("alice", "Alice");
  const bob = await createReference("bob", "Bob");
  const { trigger, card } = openReference(alice);
  await vi.dynamicImportSettled();

  bob.label = "Robert";
  bob.profileId = "robert";
  await settle(bob);
  expect(dialog()).toBe(card);
  expect(card.getAttribute("aria-label")).toBe("Activity for Alice");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");

  alice.label = "Alicia";
  await settle(alice);
  expect(queries(alice).getByRole("button")).toBe(trigger);
  expect(dialog()).toBe(card);
  expect(card.getAttribute("aria-label")).toBe("Activity for Alicia");

  alice.profileId = "alicia";
  await settle(alice);
  expect(card.isConnected).toBe(false);
  expect(dialog()).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

it("disconnects a retired mention without retiring another card or losing exclusivity", async () => {
  const alice = await createReference("alice", "Alice");
  const bob = await createReference("bob", "Bob");
  const first = openReference(alice);
  const second = openReference(bob);
  expect(first.card.isConnected).toBe(false);

  alice.remove();
  await settle();
  expect(dialog()).toBe(second.card);
  expect(second.trigger.getAttribute("aria-expanded")).toBe("true");

  document.body.append(alice);
  await settle(alice);
  const reopened = openReference(alice);
  expect(reopened.card.getAttribute("aria-label")).toBe("Activity for Alice");
  expect(second.card.isConnected).toBe(false);
  expect(second.trigger.getAttribute("aria-expanded")).toBe("false");

  alice.remove();
  await settle();
  expect(reopened.card.isConnected).toBe(false);
  expect(dialog()).toBeNull();
});

it("refreshes an open unresolved card after a locale change without replacing it", async () => {
  const alice = await createReference("alice", "Alice");
  const { trigger, card } = openReference(alice);
  expect(queries(card).getByRole("status").textContent).toBe("Could not load people. Try again.");
  expect(card.getAttribute("aria-label")).toBe("Activity for Alice");

  await i18n.setLocale("de");
  flush();
  expect(dialog()).toBe(card);
  expect(queries(alice).getByRole("button")).toBe(trigger);
  expect(card.getAttribute("aria-label")).toBe("Aktivität von Alice");
  expect(queries(card).getByRole("status").textContent).toBe(
    "Personen konnten nicht geladen werden. Versuchen Sie es erneut.",
  );
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
});

it.each(["escape", "profile", "disconnect", "connection"] as const)(
  "retires a pending person-card import on %s without reading or reopening",
  async (retirement) => {
    const gate = Promise.withResolvers<void>();
    const spy = vi
      .spyOn(idleImport, "createIdleImport")
      .mockImplementation(<T,>(load: () => Promise<T>, onLoaded?: (value: T) => void) =>
        createIdleImport(async () => {
          await gate.promise;
          return load();
        }, onLoaded),
      );
    onTestFinished(() => {
      gate.resolve();
      spy.mockRestore();
    });
    const { context: ownerContext, request, publish } = createSessionOwnerMenuHarness();
    const context = { ...ownerContext, router: createSidebarTestRouter() };
    const provider = document.createElement("div");
    const view = mountSolid(() => <ApplicationProvider host={provider} value={context} />, {
      container: provider,
    });
    document.body.append(provider);
    try {
      const host = await createReference("profile-ada", "Ada", provider);
      const directoryReads = request.mock.calls.filter(
        ([method]) => method === "users.list",
      ).length;
      const { trigger, card } = openReference(host);
      expect(queries(card).getByRole("status").textContent).toBe("Loading…");
      if (retirement === "escape") {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      } else if (retirement === "profile") {
        host.profileId = "profile-grace";
      } else if (retirement === "disconnect") {
        host.remove();
      } else {
        publish({ phase: "reconnecting" });
      }
      await settle(host);
      gate.resolve();
      await vi.dynamicImportSettled();
      await settle();
      expect(dialog()).toBeNull();
      expect(card.isConnected).toBe(false);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(request.mock.calls.filter(([method]) => method === "users.list")).toHaveLength(
        directoryReads,
      );
    } finally {
      gate.resolve();
      provider.remove();
      view.unmount();
    }
  },
);
