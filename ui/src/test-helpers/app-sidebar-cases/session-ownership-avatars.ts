import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createGatewayHarness, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { waitForSolid } from "../solid-settle.ts";
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
    const harness = createSessionsHarness(
      "main",
      ["main", "ada", "bob", "carol"].map((id) => `agent:main:${id}`),
    );
    const result = harness.sessions.state.result!;
    result.owners = ["Ada", "Bob", "Carol"].map((label, index) => {
      const name = label.toLowerCase();
      const actor = { type: "human" as const, id: `profile-${name}`, label };
      setEffectiveOwner(
        result.sessions.find((row) => row.key.endsWith(`:${name}`))!,
        {
          ...actor,
          ...(index < 2 ? { avatarUrl: `/api/users/profile-${name}/avatar?v=${index + 1}` } : {}),
        },
      );
      return actor;
    });

    const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
    harness.publishList({ result, agentId: "main" });

    const chip = (name: string) =>
      sidebar.querySelector(`[data-session-key="agent:main:${name}"] .session-owner-chip`);
    const image = (name: string) =>
      sidebar.querySelector(`[data-session-key="agent:main:${name}"] openclaw-viewer-avatar img`);
    await waitForFast(() => {
      expect(image("ada")).not.toBeNull();
      expect(image("bob")).not.toBeNull();
    });
    const bobAvatarBefore = image("bob")?.getAttribute("src");
    expect(chip("bob")?.classList.contains("session-owner-chip--away")).toBe(true);

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
    expect(image("bob")?.getAttribute("src")).toBe(bobAvatarBefore);
    const bobChip = chip("bob");
    expect(bobChip?.classList.contains("session-owner-chip--away")).toBe(false);
    expect(bobChip?.getAttribute("title")).toBe("Created by Bob · viewing now");

    const adaChip = chip("ada");
    expect(adaChip?.getAttribute("aria-label")).toBe("Created by Ada");
    expect(adaChip?.getAttribute("title")).toBe("Created by Ada");
    adaChip?.querySelector("img")?.dispatchEvent(new Event("error"));
    await waitForSolid(() =>
      expect(adaChip?.querySelector(".viewer-avatar")?.classList.contains("is-fallback")).toBe(
        true,
      ),
    );

    const carolChip = chip("carol");
    expect(carolChip?.querySelector("img")).toBeNull();
    expect(carolChip?.textContent?.trim()).toBe("C");
  });

  it("uses agent faces while preserving human owner grapheme initials", async () => {
    for (const { type, label, expected } of [
      { type: "agent" as const, label: "Roboclaw", expected: null },
      { type: "human" as const, label: "🦞小明", expected: "🦞" },
      { type: "human" as const, label: "👨‍👩‍👧‍👦Family", expected: "👨‍👩‍👧‍👦" },
    ]) {
      const { gateway } = createGatewayHarness({} as GatewayBrowserClient);
      const harness = createSessionsHarness("main", ["agent:main:main", "agent:main:lobster"]);
      const result = harness.sessions.state.result!;
      const lobster = result.sessions.find((row) => row.key.endsWith(":lobster"))!;
      setEffectiveOwner(lobster, { type, id: "profile-lobster", label });
      result.owners = [
        { type, id: "profile-lobster", label },
        { type: "human", id: "profile-ada", label: "Ada" },
        { type: "human", id: "profile-bob", label: "Bob" },
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
