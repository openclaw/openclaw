/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionParticipant } from "../../../../../packages/gateway-protocol/src/schema/session-participant.js";
import { i18n } from "../../../i18n/index.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ChatDetailsPeople, ChatDetailsPeopleSummary } from "./chat-details-people.tsx";
import "../../../styles.css";

beforeEach(async () => {
  await i18n.setLocale("en");
  // JSDOM has no geometry. Overflow/resize behavior belongs to the browser test.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanupSolid();
  vi.unstubAllGlobals();
});

it("keeps same-name identities distinct, marks only the owner and retains focused activity links on updates", () => {
  const owner: SessionParticipant = { identity: { type: "profile", id: "alex" }, label: "Alex" };
  const remote: SessionParticipant = {
    identity: { type: "remote", pluginId: "chat", domain: "team", idKind: "user", id: "alex" },
    label: "Alex",
  };
  const [people, setPeople] = createSignal([owner, remote, owner]);
  const navigate = vi.fn();
  const view = mountSolid(() => (
    <>
      <ChatDetailsPeopleSummary people={people()} expanded={false} />
      <ChatDetailsPeople
        people={people()}
        ownerIdentity={owner.identity}
        personActivity={{ basePath: "", navigate }}
      />
    </>
  ));
  expect(view.getByText("People: 2.")).toBeDefined();
  expect(view.queryByText("2 participants")).toBeNull();
  expect(view.getAllByRole("listitem")).toHaveLength(2);
  expect(view.getAllByText("Owner")).toHaveLength(1);
  const link = view.getByRole("link", { name: "Alex Owner" });
  link.focus();
  setPeople([{ ...owner, label: "Alex Rivera" }, remote]);
  flush();
  expect(document.activeElement).toBe(link);
  expect(view.getByRole("link", { name: "Alex Rivera Owner" })).toBe(link);
  link.click();
  expect(navigate).toHaveBeenCalledExactlyOnceWith("alex", "Alex Rivera");
  expect(view.container.querySelector("[data-viewer-id]")).toBeNull();
});

it("shows three preview identities plus the remaining count, then the controlled open total", () => {
  const people: SessionParticipant[] = Array.from({ length: 8 }, (_, index) => ({
    identity: { type: "profile", id: `person-${index}` },
    label: `Person ${index}`,
  }));
  const [expanded, setExpanded] = createSignal(false);
  const [available, setAvailable] = createSignal(people);
  const view = mountSolid(() => (
    <ChatDetailsPeopleSummary people={available()} expanded={expanded()} />
  ));
  expect(view.getByText("People: 8.")).toBeDefined();
  expect(view.getByText("+5")).toBeDefined();
  expect(view.container.querySelectorAll(".chat-details-people__preview-avatar")).toHaveLength(3);
  expect(view.container.querySelector("a, button")).toBeNull();
  setExpanded(true);
  flush();
  expect(view.getByText("8")).toBeDefined();
  expect(view.queryByText("+5")).toBeNull();
  setAvailable(people.slice(0, 2));
  flush();
  expect(view.getByText("2")).toBeDefined();
  setExpanded(false);
  flush();
  expect(view.container.querySelector(".chat-details-people__overflow")).toBeNull();
});

it("omits count metadata for a partial People list", () => {
  const people: SessionParticipant[] = [
    { identity: { type: "profile", id: "owner" }, label: "Owner" },
  ];
  const [partial, setPartial] = createSignal(true);
  const view = mountSolid(() => (
    <ChatDetailsPeopleSummary people={people} expanded partial={partial()} />
  ));
  expect(view.container.textContent).toBe("");
  expect(view.container.querySelector(".chat-details-people__count")).toBeNull();
  setPartial(false);
  flush();
  expect(view.getByText("1")).toBeDefined();
  expect(view.getByText("People: 1.")).toBeDefined();
});
