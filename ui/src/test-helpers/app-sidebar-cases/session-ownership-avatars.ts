import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";

export function setEffectiveOwner(
  row: GatewaySessionRow,
  actor: NonNullable<GatewaySessionRow["createdActor"]> & { id: string },
) {
  const owner: typeof actor = {
    ...actor,
    identity:
      actor.type === "agent" ? { type: "agent", id: actor.id } : { type: "profile", id: actor.id },
  };
  row.createdActor = owner;
  row.owner = { actor: owner };
}

export function registerSessionOwnershipAvatarTests() {
  it("renders durable actor avatars identically regardless of live presence", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    gateway.publish({
      selfUser: {
        id: "profile-ada",
        name: "Ada",
        avatarUrl: "/api/users/profile-ada/avatar?v=1",
      },
    });
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:ada",
      "agent:main:bob",
      "agent:main:carol",
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const ada = result.sessions.find((row) => row.key.endsWith(":ada"));
    const bob = result.sessions.find((row) => row.key.endsWith(":bob"));
    const carol = result.sessions.find((row) => row.key.endsWith(":carol"));
    if (!ada || !bob || !carol) {
      throw new Error("expected owner rows");
    }
    setEffectiveOwner(ada, {
      type: "human",
      id: "profile-ada",
      label: "Ada",
      avatarUrl: "/api/users/profile-ada/avatar?v=1",
    });
    setEffectiveOwner(bob, {
      type: "human",
      id: "profile-bob",
      label: "Bob",
      avatarUrl: "/api/users/profile-bob/avatar?v=2",
    });
    setEffectiveOwner(carol, { type: "human", id: "profile-carol", label: "Carol" });
    result.owners = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
      { type: "human", id: "profile-carol", label: "Carol" },
    ];

    const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
    harness.publishList({ result, agentId: "main" });

    await waitForFast(() => {
      expect(
        sidebar.querySelector('[data-session-key="agent:main:ada"] openclaw-viewer-avatar img'),
      ).not.toBeNull();
      expect(
        sidebar.querySelector('[data-session-key="agent:main:bob"] openclaw-viewer-avatar img'),
      ).not.toBeNull();
    });
    const bobAvatarBefore = sidebar
      .querySelector('[data-session-key="agent:main:bob"] openclaw-viewer-avatar img')
      ?.getAttribute("src");
    expect(
      sidebar
        .querySelector('[data-session-key="agent:main:bob"] .session-owner-chip')
        ?.classList.contains("session-owner-chip--away"),
    ).toBe(true);

    gateway.publishEvent("presence", {
      presence: [
        {
          instanceId: "bob-browser",
          user: {
            id: "profile-bob",
            identity: { type: "profile", id: "profile-bob" },
            name: "Bob",
            avatarUrl: "/api/users/profile-bob/avatar?v=99",
          },
          watchedSessions: ["agent:main:bob"],
        },
      ],
    });
    await sidebar.updateComplete;
    expect(
      sidebar
        .querySelector('[data-session-key="agent:main:bob"] openclaw-viewer-avatar img')
        ?.getAttribute("src"),
    ).toBe(bobAvatarBefore);
    const bobChip = sidebar.querySelector(
      '[data-session-key="agent:main:bob"] .session-owner-chip',
    );
    expect(bobChip?.classList.contains("session-owner-chip--away")).toBe(false);
    expect(bobChip?.getAttribute("title")).toBe("Created by Bob · viewing now");

    const adaChip = sidebar.querySelector(
      '[data-session-key="agent:main:ada"] .session-owner-chip',
    );
    expect(adaChip?.getAttribute("aria-label")).toBe("Created by Ada");
    expect(adaChip?.getAttribute("title")).toBe("Created by Ada");
    const adaImage = adaChip?.querySelector("img");
    adaImage?.dispatchEvent(new Event("error"));
    expect(adaChip?.querySelector(".viewer-avatar")?.classList.contains("is-fallback")).toBe(true);

    const carolChip = sidebar.querySelector(
      '[data-session-key="agent:main:carol"] .session-owner-chip',
    );
    expect(carolChip?.querySelector("img")?.getAttribute("src")).toBe(
      "/api/users/profile-carol/avatar",
    );
    expect(carolChip?.textContent?.trim()).toBe("C");
  });

  it("uses agent faces while preserving human owner grapheme initials", async () => {
    for (const { type, label, expected } of [
      { type: "agent" as const, label: "Roboclaw", expected: null },
      { type: "human" as const, label: "🦞小明", expected: "🦞" },
      { type: "human" as const, label: "👨‍👩‍👧‍👦Family", expected: "👨‍👩‍👧‍👦" },
    ]) {
      const gateway = createGateway({} as GatewayBrowserClient);
      const harness = createSessionsHarness("main", ["agent:main:main", "agent:main:lobster"]);
      const result = harness.sessions.state.result;
      if (!result) {
        throw new Error("expected session list");
      }
      const lobster = result.sessions.find((row) => row.key.endsWith(":lobster"));
      if (!lobster) {
        throw new Error("expected owner row");
      }
      setEffectiveOwner(lobster, { type, id: "profile-lobster", label });
      result.owners = [
        { type, id: "profile-lobster", label },
        { type: "human", id: "profile-ada", label: "Ada" },
      ];

      const { sidebar } = await mountSidebar(gateway, harness.sessions);
      harness.publishList({ result, agentId: "main" });
      await sidebar.updateComplete;

      const chip = sidebar.querySelector(
        '[data-session-key="agent:main:lobster"] .session-owner-chip',
      );
      if (type === "agent") {
        await vi.waitFor(() =>
          expect(chip?.querySelector(".identity-avatar__agent-face")).not.toBeNull(),
        );
      } else {
        expect(chip?.textContent?.trim()).toBe(expected);
      }
    }
  });
}
