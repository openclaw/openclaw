/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import "../test-helpers/app-sidebar-suite.ts";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { renderAppSidebarOnline } from "./app-sidebar-online.tsx";
import { projectSidebarSession } from "./app-sidebar-session-navigation.test-support.ts";
import { renderRecentSession } from "./app-sidebar-session-row-render.tsx";
import { AppSidebarOwner, type AppSidebarElement } from "./app-sidebar.tsx";

function createHost() {
  const context = createContext(
    createGateway(createTestGatewayClient(async () => ({}))),
    createSessions("main", []),
  );
  const container = document.createElement("div");
  const props = document.createElement("openclaw-app-sidebar") as AppSidebarElement;
  props.sidebarAgentsMode = "roster";
  const host = new AppSidebarOwner(props, context, container);
  host.sessionOwnershipVisibility = { filters: true, avatars: true };
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
    const [revision, setRevision] = createSignal(0);
    const observedHost = new Proxy(host, {
      get(target, key, receiver) {
        revision();
        return Reflect.get(target, key, receiver);
      },
    });
    mountSolid(
      () =>
        renderRecentSession({
          host: observedHost,
          get session() {
            revision();
            return session;
          },
        }),
      { container },
    );
    const update = () => {
      setRevision((value) => value + 1);
      flush();
    };
    update();
    const row = container.querySelector(".sidebar-recent-session")!;
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
    expect(container.querySelector(".sidebar-recent-session")).toBe(row);
    expect(container.querySelector("openclaw-viewer-facepile")).toBe(facepile);
    expect(facepile.querySelector(".viewer-facepile")?.getAttribute("aria-label")).toBe("ada");
  },
);

it("updates a pinned session's resolved avatar without replacing its row", () => {
  const { host, container } = createHost();
  const session = projectSidebarSession({ key: "agent:main:pinned" });
  const [avatar, setAvatar] = createSignal("Loading avatar");
  mountSolid(
    () =>
      renderRecentSession({
        host,
        session,
        get icon() {
          const label = avatar();
          return <span data-pinned-avatar>{label}</span>;
        },
      }),
    { container },
  );
  const row = container.querySelector(".sidebar-recent-session");
  expect(container.querySelector("[data-pinned-avatar]")?.textContent).toBe("Loading avatar");

  setAvatar("Ada");
  flush();

  expect(container.querySelector("[data-pinned-avatar]")?.textContent).toBe("Ada");
  expect(container.querySelector(".sidebar-recent-session")).toBe(row);
});

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
  const [revision, setRevision] = createSignal(0);
  const observedHost = new Proxy(host, {
    get(target, key, receiver) {
      revision();
      return Reflect.get(target, key, receiver);
    },
  });
  mountSolid(() => renderAppSidebarOnline(observedHost), { container });
  const update = () => {
    setRevision((value) => value + 1);
    flush();
  };
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
