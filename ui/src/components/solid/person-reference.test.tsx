/* @vitest-environment jsdom */
import { getQueriesForElement } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import "./person-reference.tsx";

type PersonReferenceElement = HTMLElementTagNameMap["openclaw-person-reference"];
const hosts: PersonReferenceElement[] = [];
let restoreI18n: ReturnType<typeof captureI18nStateForTesting>;
const queries = (element: HTMLElement = document.body) => getQueriesForElement(element);
const dialog = () => queries().queryByRole("dialog");

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

async function createReference(profileId: string, label: string) {
  const host = document.createElement("openclaw-person-reference");
  hosts.push(host);
  host.profileId = profileId;
  host.label = label;
  document.body.append(host);
  await settle(host);
  return host;
}

function openReference(host: PersonReferenceElement) {
  const trigger = queries(host).getByRole("button");
  trigger.click();
  flush();
  return { trigger, card: queries().getByRole("dialog") };
}

it("routes label and profile changes to their active mention only", async () => {
  const alice = await createReference("alice", "Alice");
  const bob = await createReference("bob", "Bob");
  const { trigger, card } = openReference(alice);

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
