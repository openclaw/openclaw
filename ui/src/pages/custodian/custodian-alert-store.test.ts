/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { CustodianAlert } from "../../components/custodian-alert-contract.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { custodianAlertStore } from "./custodian-alert-store.ts";
import { createContext } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";
import "./custodian-surface.tsx";

const incident: CustodianAlert = {
  id: "recurring-incident",
  title: "1 automation failed",
  facts: ["Nightly backup: disk full"],
  question: "Why did Nightly backup fail?",
};

afterEach(() => {
  custodianAlertStore.dismiss();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("asks once per presentation and re-arms the same incident", () => {
  const send = vi.fn();
  const listener = vi.fn();
  const unsubscribe = custodianAlertStore.subscribe(listener);
  custodianAlertStore.present(incident);
  expect(custodianAlertStore.alert).toBe(incident);
  expect(listener).toHaveBeenCalledOnce();
  custodianAlertStore.askIfReady(send);
  custodianAlertStore.askIfReady(send);
  expect(send).toHaveBeenCalledExactlyOnceWith(incident.question);
  custodianAlertStore.dismiss();
  expect(custodianAlertStore.alert).toBeNull();
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  custodianAlertStore.present(incident);
  custodianAlertStore.askIfReady(send);
  expect(send).toHaveBeenCalledTimes(2);
});

it("retires scoped facts and a queued question when its owner loses authority", () => {
  let current = true;
  const admit = vi.fn(() => true);
  const send = vi.fn();
  custodianAlertStore.present(incident, { isCurrent: () => current, admit });
  current = false;

  custodianAlertStore.askIfReady(send);

  expect(custodianAlertStore.alert).toBeNull();
  expect(admit).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it("renders without sending when custodian chat is unavailable", async () => {
  const { context } = createContext(vi.fn(), []);
  const provider = createApplicationContextProvider(context);
  const sessionStore = new CustodianSessionStore();
  const send = vi.spyOn(sessionStore, "send");
  const surface = document.createElement("openclaw-custodian-surface");
  surface.store = sessionStore;
  provider.append(surface);
  document.body.append(provider);

  custodianAlertStore.present(incident);
  await surface.updateComplete;

  expect(send).not.toHaveBeenCalled();
  expect(surface.querySelector(".custodian__alert-card")?.textContent).toContain(
    "Nightly backup: disk full",
  );
});
