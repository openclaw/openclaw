/* @vitest-environment jsdom */

import { render } from "lit";
import { expect, it, vi } from "vitest";
import "../test-helpers/app-sidebar-suite.ts";
import { renderAppSidebarOnline } from "./app-sidebar-online.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.ts";
import { projectSidebarSession } from "./app-sidebar-session-navigation.test-support.ts";
import { renderRecentSession, type SessionListHost } from "./app-sidebar-session-row-render.ts";
import "./app-sidebar.ts";

function createHost() {
  const host = document.createElement("openclaw-app-sidebar") as AppSidebarRenderHost &
    SessionListHost;
  host.sidebarAgentsMode = "roster";
  host.sessionOwnershipVisibility = { filters: true, avatars: true };
  const container = document.createElement("div");
  document.body.append(container);
  return { host, container };
}

it.each([false, true])(
  "keeps row facepiles idle with unchanged inputs (owner: %s), while admitting new presence",
  async (withOwner) => {
    const { host, container } = createHost();
    const session = projectSidebarSession({
      key: "agent:main:thread",
      owner: withOwner
        ? { actor: { type: "human", id: "ada", identity: { type: "profile", id: "ada" } } }
        : undefined,
    });
    const presence = ["ada", "bea"].map((id) => ({
      ts: 1,
      user: { id, identity: { type: "profile" as const, id }, name: id },
      watchedSessions: [session.key],
    }));
    host.sessionData.presencePayload = { presence };
    const update = () => render(renderRecentSession({ host, session }), container);
    update();
    const facepile = container.querySelector("openclaw-viewer-facepile")!;
    await facepile.updateComplete;
    const updates = vi.spyOn(facepile, "performUpdate");

    update();
    await facepile.updateComplete;
    expect(updates).not.toHaveBeenCalled();

    host.sessionData.presencePayload = { presence: presence.slice(0, 1) };
    update();
    await facepile.updateComplete;
    expect(updates).toHaveBeenCalledOnce();
    expect(facepile.querySelector(".viewer-facepile")?.getAttribute("aria-label")).toBe(
      withOwner ? undefined : "ada",
    );

    session.owner = {
      actor: { type: "human", id: "bea", identity: { type: "profile", id: "bea" } },
    };
    update();
    await facepile.updateComplete;
    expect(updates).toHaveBeenCalledTimes(2);
    expect(facepile.querySelector(".viewer-facepile")?.getAttribute("aria-label")).toBe("ada");
  },
);

it("keeps Online facepiles idle until presence or time-sensitive ordering changes", async () => {
  vi.useFakeTimers();
  const now = 1_800_000_000_000;
  vi.setSystemTime(now);
  const { host, container } = createHost();
  const presence = ["ada", "zoe"].map((id) => ({
    ts: now,
    user: { id, identity: { type: "profile" as const, id }, name: id },
    lastActivityAt: id === "ada" ? now - 119_999 : now,
  }));
  host.sessionData.presencePayload = { presence };
  const update = () => render(renderAppSidebarOnline(host), container);
  update();
  const facepile = container.querySelector("openclaw-viewer-facepile")!;
  await facepile.updateComplete;
  const updates = vi.spyOn(facepile, "performUpdate");

  update();
  await facepile.updateComplete;
  expect(updates).not.toHaveBeenCalled();

  vi.setSystemTime(now + 2);
  update();
  await facepile.updateComplete;
  expect(updates).toHaveBeenCalledOnce();
  expect(facepile.querySelector(".viewer-facepile")?.getAttribute("aria-label")).toBe("zoe, ada");

  host.sessionData.presencePayload = { presence: presence.slice(0, 1) };
  update();
  await facepile.updateComplete;
  expect(updates).toHaveBeenCalledTimes(2);
  expect(facepile.querySelector(".viewer-facepile")?.getAttribute("aria-label")).toBe("ada");
});
