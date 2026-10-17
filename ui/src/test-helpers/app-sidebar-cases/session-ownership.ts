import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { openSessionMenu, sessionMenuChoice, selectSessionMenuValue } from "../app-sidebar-menu.ts";
import { createGatewayHarness, type SidebarLifecycleState } from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";
import { waitForFast } from "../wait-for.ts";
import {
  registerSessionOwnershipAvatarTests,
  setEffectiveOwner,
} from "./session-ownership-avatars.ts";
import { sessionFixture, human } from "./session-suite.test-support.ts";
import "../../components/app-sidebar.tsx";

async function expectSelected(menu: Awaited<ReturnType<typeof openSessionMenu>>, value: string) {
  expect((await sessionMenuChoice(menu, value))?.getAttribute("aria-selected")).toBe("true");
}

async function expectSort(sidebar: SidebarLifecycleState, mode: string, keys: string[]) {
  await selectSessionMenuValue(sidebar, `sort:${mode}`);
  expect(visibleSessionKeys(sidebar)).toEqual(keys);
}

function sessionSharingHello(hasMultipleIdentities: boolean) {
  return {
    policy: { hasMultipleSessionSharingIdentities: hasMultipleIdentities },
  } as ApplicationGatewaySnapshot["hello"];
}

function visibleSessionKeys(sidebar: SidebarLifecycleState): string[] {
  return [...sidebar.querySelectorAll<HTMLElement>(".sidebar-recent-session[data-session-key]")]
    .filter((row) => !row.classList.contains("sidebar-recent-session--child"))
    .map((row) => row.dataset.sessionKey ?? "");
}

async function publishOwnership(
  harness: ReturnType<typeof sessionFixture>,
  sidebar: SidebarLifecycleState,
) {
  harness.publishList({ result: harness.result, agentId: "main" });
  await sidebar.updateComplete;
}

describe("AppSidebar session ownership", () => {
  registerSessionOwnershipAvatarTests();

  it("hides only solo self avatars under self filters with qualified self identity", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    gateway.publish({
      selfUser: {
        id: "raw-login",
        identity: { type: "profile", id: "profile-ada" },
        name: "Ada",
      },
    });
    const harness = sessionFixture([
      "agent:main:main",
      "agent:main:solo",
      "agent:main:shared",
      "agent:main:collab",
    ]);
    const result = harness.result;
    const solo = harness.row("agent:main:solo");
    const shared = harness.row("agent:main:shared");
    const collab = harness.row("agent:main:collab");
    setEffectiveOwner(solo, human("Ada"));
    solo.hasActiveRun = true;
    solo.status = "running";
    setEffectiveOwner(shared, human("Ada"));
    shared.participants = [{ identity: { type: "profile", id: "profile-bob" }, label: "Bob" }];
    shared.participantCount = 1;
    setEffectiveOwner(collab, human("Bob"));
    collab.participants = [{ identity: { type: "profile", id: "profile-ada" }, label: "Ada" }];
    collab.participantCount = 1;
    result.owners = [human("Ada"), human("Bob")];

    const { sidebar, query } = await harness.mount(gateway.gateway);
    await publishOwnership(harness, sidebar);
    expect(query("agent:main:collab", ".session-owner-stack")).not.toBeNull();

    await selectSessionMenuValue(sidebar, "involving-me");
    expect(harness.list).toHaveBeenCalledWith(expect.objectContaining({ involvingMe: true }));
    const soloRow = () => query(solo.key)!;
    const sharedRow = () => query(shared.key)!;
    expect(soloRow().querySelector("openclaw-session-owner-chip")).toBeNull();
    expect(soloRow().querySelector('[aria-label="Active run"]')).not.toBeNull();
    expect(sharedRow().querySelector(".session-owner-stack")).not.toBeNull();
    expect(query(collab.key, ".session-owner-stack")).not.toBeNull();

    await selectSessionMenuValue(sidebar, "owner:profile-ada");
    expect(soloRow().querySelector("openclaw-session-owner-chip")).toBeNull();
    expect(sharedRow().querySelector(".session-owner-stack")).not.toBeNull();

    // The complete count, not just the bounded sample, preserves collaboration.
    shared.participants = [];
    shared.participantCount = 5;
    harness.publishList({ result, agentId: "main" });
    await sidebar.sessionData.refreshSidebarSessions();
    await sidebar.updateComplete;
    expect(sharedRow().querySelector(".session-owner-stack__overflow")?.textContent).toBe("+5");

    await selectSessionMenuValue(sidebar, "owner:");
    expect(soloRow().querySelector("openclaw-session-owner-chip")).not.toBeNull();
  });

  it("traces the run around a stacked owner row and rings a solo owner row", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const harness = sessionFixture(["agent:main:main", "agent:main:solo", "agent:main:collab"]);
    const result = harness.result;
    const solo = harness.row("agent:main:solo");
    const collab = harness.row("agent:main:collab");
    setEffectiveOwner(solo, human("Ada"));
    setEffectiveOwner(collab, human("Ada"));
    collab.participants = [{ identity: { type: "profile", id: "profile-bob" }, label: "Bob" }];
    collab.participantCount = 1;
    for (const row of [solo, collab]) {
      row.hasActiveRun = true;
      row.status = "running";
    }
    result.owners = [human("Ada"), human("Bob")];
    const { sidebar, query } = await harness.mount(gateway.gateway);
    await publishOwnership(harness, sidebar);
    const soloRow = query("agent:main:solo")!;
    const collabRow = query("agent:main:collab")!;
    expect(soloRow.querySelector(".session-glyph__ring")).not.toBeNull();
    expect(soloRow.querySelector(".session-glyph__trace")).toBeNull();
    expect(collabRow.querySelector(".session-glyph__ring")).toBeNull();
    const trace = collabRow.querySelector(".session-glyph__trace");
    expect(trace?.getAttribute("aria-label")).toBe("Active run");
    expect(trace?.querySelector(".session-glyph__trace-run")?.getAttribute("pathLength")).toBe(
      "100",
    );
  });

  it("deduplicates only visible participant identities with an unqualified viewer", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const harness = sessionFixture(["agent:main:main", "agent:main:collab"]);
    const result = harness.result;
    const collab = result.sessions[1]!;
    setEffectiveOwner(collab, human("Ada"));
    collab.participants = [{ identity: { type: "profile", id: "profile-bob" }, label: "Bob" }];
    collab.participantCount = 1;
    result.owners = [human("Ada"), human("Bob")];
    const { sidebar, query } = await harness.mount(gateway.gateway);
    harness.publishList({ result, agentId: "main" });
    gateway.publishEvent("presence", {
      presence: ["ada", "bob", "carol"].map((name) => {
        const id = `profile-${name}`;
        return {
          instanceId: id,
          user: {
            id,
            ...(name !== "bob" ? { identity: { type: "profile" as const, id } } : {}),
          },
          watchedSessions: [collab.key],
        };
      }),
    });
    await sidebar.updateComplete;
    const row = query("agent:main:collab")!;
    await waitForFast(() =>
      expect(
        [...row.querySelectorAll("[data-viewer-id]")].map((avatar) =>
          avatar.getAttribute("data-viewer-id"),
        ),
      ).toEqual(["profile-carol", "profile-bob"]),
    );
    expect(row.querySelector(".session-owner-stack")).not.toBeNull();
  });

  it("hides session-row owner avatars for one human with truncated agents", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    gateway.publish({
      selfUser: {
        id: "profile-ada",
        name: "Ada",
        avatarUrl: "/api/users/profile-ada/avatar",
      },
    });
    const harness = sessionFixture(["agent:main:main", "agent:main:a", "agent:main:b"]);
    const result = harness.result;
    for (const row of result.sessions) {
      setEffectiveOwner(row, human("Ada"));
      row.participants = [{ identity: { type: "profile", id: "profile-ada" }, label: "Ada" }];
      row.participantCount = 1;
    }
    result.owners = [human("Ada")];
    result.sessions[1]!.participants = [{ identity: { type: "agent", id: "research" } }];
    result.sessions[1]!.participantCount = 5;
    const { sidebar, query } = await harness.mount(gateway.gateway);
    await publishOwnership(harness, sidebar);

    expect(sidebar.querySelector(".sidebar-recent-session openclaw-session-owner-chip")).toBeNull();

    // A second human participant enables attribution even without another owner.
    result.sessions[1]!.participants = [{ identity: { type: "profile", id: "profile-bob" } }];
    result.sessions[1]!.participantCount = 1;
    await publishOwnership(harness, sidebar);
    expect(query("agent:main:a", "openclaw-session-owner-chip")).not.toBeNull();
  });

  it("owns People availability and fallback at the live session-owner roster", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    gateway.publish({ hello: sessionSharingHello(true) });
    const keys = ["main", "b1", "a1", "b2", "a2"].map((id) => `agent:main:${id}`);
    const harness = sessionFixture(keys);
    const result = harness.result;
    for (const [index, id, label, updatedAt] of [
      [1, "profile-bob", "Bob", 40],
      [2, "profile-ada", "Ada", 40],
      [3, "profile-bob", "Bob", 30],
      [4, "profile-ada", "Ada", 20],
    ] as const) {
      Object.assign(result.sessions[index]!, {
        createdActor: { type: "human", id, label },
        owner: { actor: { type: "human", id, label } },
        updatedAt,
      });
    }
    result.owners = [human("Bob")];
    const createdOrder = keys.slice(1);
    // b1 and a1 tie at updatedAt 40; the ascending-key tie-break (mirroring
    // the gateway list order) puts a1 first.
    const updatedOrder = [keys[2]!, keys[1]!, keys[3]!, keys[4]!];
    const peopleOrder = [keys[2]!, keys[4]!, keys[1]!, keys[3]!];

    const { sidebar } = await harness.mount(gateway.gateway);
    await publishOwnership(harness, sidebar);

    let menu = await openSessionMenu(sidebar);
    expect(await sessionMenuChoice(menu, "sort:people")).toBeNull();
    await expectSelected(menu, "sort:created");
    sidebar.dismissTransientMenus();
    await sidebar.updateComplete;

    result.owners = [human("Ada"), human("Bob")];
    gateway.publish({ hello: sessionSharingHello(false) });
    await publishOwnership(harness, sidebar);
    await expectSort(sidebar, "people", peopleOrder);

    result.owners = undefined;
    await publishOwnership(harness, sidebar);
    menu = await openSessionMenu(sidebar);
    await expectSelected(menu, "sort:people");
    expect(visibleSessionKeys(sidebar)).toEqual(peopleOrder);
    sidebar.dismissTransientMenus();
    await sidebar.updateComplete;

    result.owners = [human("Ada"), human("Bob")];
    await publishOwnership(harness, sidebar);
    menu = await openSessionMenu(sidebar);
    await expectSelected(menu, "sort:people");
    expect(visibleSessionKeys(sidebar)).toEqual(peopleOrder);
    sidebar.dismissTransientMenus();
    await sidebar.updateComplete;

    await expectSort(sidebar, "updated", updatedOrder);
    await expectSort(sidebar, "created", createdOrder);
    await expectSort(sidebar, "people", peopleOrder);
    result.owners = [human("Bob")];
    gateway.publish({ hello: sessionSharingHello(true) });
    await publishOwnership(harness, sidebar);
    await sidebar.updateComplete;

    menu = await openSessionMenu(sidebar);
    expect(await sessionMenuChoice(menu, "sort:people")).toBeNull();
    await expectSelected(menu, "sort:created");
    sidebar.dismissTransientMenus();
    result.owners = [human("Ada"), human("Bob")];
    gateway.publish({ hello: sessionSharingHello(false) });
    await publishOwnership(harness, sidebar);
    menu = await openSessionMenu(sidebar);
    expect(await sessionMenuChoice(menu, "sort:people")).not.toBeNull();
    await expectSelected(menu, "sort:created");
  });

  it("groups sessions by owner based on the live session-owner roster", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    gateway.publish({
      hello: sessionSharingHello(false),
      selfUser: { id: "profile-zoe", name: "Zoe" },
    });
    const harness = sessionFixture(["agent:main:main", "agent:main:ada", "agent:main:zoe"]);
    const result = harness.result;
    const ada = harness.row("agent:main:ada");
    const zoe = harness.row("agent:main:zoe");
    setEffectiveOwner(ada, human("Ada"));
    setEffectiveOwner(zoe, { ...human("Zoe"), avatarUrl: "/avatars/zoe" });
    result.owners = [human("Ada"), human("Zoe")];

    const { sidebar } = await harness.mount(gateway.gateway);
    await publishOwnership(harness, sidebar);

    let menu = await openSessionMenu(sidebar);
    expect(await sessionMenuChoice(menu, "grouping:person")).not.toBeNull();
    sidebar.dismissTransientMenus();
    await sidebar.updateComplete;

    await selectSessionMenuValue(sidebar, "grouping:person");

    const ownerSections = () => [
      ...sidebar.querySelectorAll<HTMLElement>('[data-session-section^="person:"]'),
    ];
    expect(ownerSections().map((section) => section.dataset.sessionSection)).toEqual([
      "person:profile:profile-zoe",
      "person:profile:profile-ada",
    ]);
    const firstSection = domProbe(ownerSections()[0]!);
    expect(firstSection.text(".sidebar-recent-sessions__label-text")).toBe("Zoe");
    expect(firstSection.attr("openclaw-viewer-avatar", "aria-hidden")).toBe("true");
    expect(firstSection.attr(".sidebar-recent-sessions__head", "draggable")).toBe("false");
    // Derived person sections keep filtering in the shared Sessions toolbar.
    expect(ownerSections()[0]?.querySelector(".sidebar-session-group-actions")).toBeNull();

    result.owners = undefined;
    await publishOwnership(harness, sidebar);
    expect(ownerSections()).toHaveLength(2);
    menu = await openSessionMenu(sidebar);
    await expectSelected(menu, "grouping:person");
    sidebar.dismissTransientMenus();
    await sidebar.updateComplete;

    result.owners = [human("Ada"), human("Zoe")];
    await publishOwnership(harness, sidebar);
    expect(ownerSections()).toHaveLength(2);

    gateway.publish({ hello: sessionSharingHello(true) });
    result.owners = [human("Zoe")];
    await publishOwnership(harness, sidebar);
    expect(ownerSections()).toHaveLength(0);
    menu = await openSessionMenu(sidebar);
    expect(await sessionMenuChoice(menu, "grouping:person")).toBeNull();
    await expectSelected(menu, "grouping:category");
    sidebar.dismissTransientMenus();

    result.owners = [human("Ada"), human("Zoe")];
    gateway.publish({ hello: sessionSharingHello(false) });
    await publishOwnership(harness, sidebar);
    expect(ownerSections()).toHaveLength(2);
  });

  it("shows archive attribution only in collaborative archived-session lists", async () => {
    const harness = sessionFixture([
      "agent:main:main",
      "agent:main:archived",
      "agent:main:collaborator",
    ]);
    const result = harness.result;
    const archived = harness.row("agent:main:archived");
    const collaborator = harness.row("agent:main:collaborator");
    archived.archived = true;
    archived.archivedBy = { ...human("Bob"), identity: { type: "profile", id: "profile-bob" } };
    setEffectiveOwner(archived, human("Ada"));
    setEffectiveOwner(collaborator, human("Bob"));
    result.owners = [human("Ada"), human("Bob")];

    const { sidebar, query } = await harness.mount();
    Object.assign(sidebar, { sessionsStatusFilter: "archived" });
    await publishOwnership(harness, sidebar);

    expect(
      sidebar.querySelector('openclaw-session-owner-chip span[title="Archived by Bob"]'),
    ).not.toBeNull();
    expect(sidebar.querySelector('span[title="Created by Ada"]')).toBeNull();
    // Facepile dedup follows the rendered lead: the archivist chip is shown,
    // so Bob is excluded while owner Ada must stay visible as a viewer.
    const archivedFacepile = query<HTMLElementTagNameMap["openclaw-viewer-facepile"]>(
      archived.key,
      "openclaw-viewer-facepile",
    );
    expect(archivedFacepile?.excludeIdentities).toEqual([archived.archivedBy.identity]);

    setEffectiveOwner(collaborator, human("Ada"));
    result.owners = [human("Ada")];
    await publishOwnership(harness, sidebar);

    expect(sidebar.querySelector("openclaw-session-owner-chip")).toBeNull();
    const soloFacepile = query<HTMLElementTagNameMap["openclaw-viewer-facepile"]>(
      archived.key,
      "openclaw-viewer-facepile",
    );
    expect(soloFacepile?.excludeIdentities).toEqual([]);
  });
});
