import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { PaneHeaderPresence } from "../chat-pane-header-view.tsx";
import { ChatDetailsPeople, ChatDetailsPeopleSummary } from "./chat-details-people.tsx";
import "../../../styles.css";

beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(cleanupSolid);

it("shows a known unloaded remainder without fabricating people and fades only overflowing names", async () => {
  const [name, setName] = createSignal("Alexandra Montgomery from the international design team");
  const view = mountSolid(() => (
    <div style={{ width: "190px" }}>
      <ChatDetailsPeople
        people={[{ identity: { type: "profile", id: "alex" }, label: name() }]}
        totalCount={8}
      />
      <ChatDetailsPeopleSummary
        people={[{ identity: { type: "profile", id: "alex" }, label: name() }]}
        totalCount={8}
        expanded={false}
      />
    </div>
  ));
  // Keep rename width fixed so tooltip updates cannot rely on a resize.
  view.container.style.fontFamily = "monospace";
  const label = view.container.querySelector<HTMLElement>(".chat-details-people__name")!;
  await document.fonts.ready;
  await expect.poll(() => label.hasAttribute("data-overflow")).toBe(true);
  expect(label.title).toBe("Alexandra Montgomery from the international design team");
  const textWidth = label.firstElementChild!.getBoundingClientRect().width;
  const renamed = "Montgomery Alexandra from the international design team";
  setName(renamed);
  await expect.poll(() => label.textContent).toBe(renamed);
  expect(label.firstElementChild!.getBoundingClientRect().width).toBe(textWidth);
  await expect.poll(() => label.title).toBe(renamed);
  expect(view.getByText("7 more participants")).toBeDefined();
  expect(view.getByText("+7")).toBeDefined();
  expect(view.container.querySelectorAll(".chat-details-people__preview-avatar")).toHaveLength(1);
  view.container.firstElementChild!.setAttribute("style", "width: 900px");
  await expect.poll(() => label.hasAttribute("data-overflow")).toBe(false);
  view.container.firstElementChild!.setAttribute("style", "width: 190px");
  await expect.poll(() => label.hasAttribute("data-overflow")).toBe(true);
  setName("Alex");
  await expect.poll(() => label.hasAttribute("data-overflow")).toBe(false);
  expect(label.hasAttribute("title")).toBe(false);
});

it("keeps desktop viewers at three plus overflow with native activity targets", async () => {
  const navigate = vi.fn();
  const users = ["Alex", "Blair", "Casey", "Drew", "Eden"].map((name) => ({
    id: name.toLowerCase(),
    name,
    identity: { type: "profile" as const, id: name.toLowerCase() },
    watchedSessions: [],
  }));
  const view = mountSolid(() => (
    <PaneHeaderPresence staticUsers={users} personActivity={{ basePath: "", navigate }} />
  ));
  await view.container.querySelector("openclaw-viewer-facepile")!.updateComplete;
  await expect.poll(() => view.container.querySelectorAll("[data-viewer-id]").length).toBe(3);
  expect(view.getByText("+2")).toBeDefined();
  view.getByRole("link", { name: "Alex" }).click();
  expect(navigate).toHaveBeenCalledExactlyOnceWith("alex", "Alex");
  const avatar = view.container.querySelector(".viewer-avatar")!;
  expect(avatar.getBoundingClientRect().width).toBe(24);
  expect(view.getByText("+2").getBoundingClientRect().width).toBe(28);
});
