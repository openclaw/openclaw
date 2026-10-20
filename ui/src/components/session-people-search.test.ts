/* @vitest-environment jsdom */
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { mountMenu, openSubmenu } from "../test-helpers/session-menu.ts";
import {
  createSessionOwnerMenuHarness,
  sessionOwnerProfiles,
} from "../test-helpers/session-owner-menu.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { mountPeopleSharing } from "./session-people-search.test-support.ts";

const owners = (root: ParentNode) => root.querySelectorAll('[data-value^="assign-owner:"]');

describe("searchable session people", () => {
  it("preserves a loading query until the connection changes", async () => {
    const pending = createDeferred<ReturnType<typeof sessionOwnerProfiles>>();
    const { context, request, publish } = createSessionOwnerMenuHarness(() => pending.promise);
    const menu = await mountMenu({ context });
    await openSubmenu(menu, "Assign to…");
    await waitForFast(() => expect(request).toHaveBeenCalledWith("users.list", {}));
    const search = menu.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "Carol";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));

    pending.resolve(sessionOwnerProfiles("Ada", "Bob", "Carol"));
    await waitForFast(() => expect(menu.textContent).toContain("Carol"));
    expect(search.value).toBe("Carol");
    expect(owners(menu)).toHaveLength(1);

    publish({ phase: "reconnecting" });
    publish({ phase: "connected" });
    await waitForSolid(() => expect(search.value).toBe(""));
  });

  it("refreshes agent labels from identity publications without clearing the search", async () => {
    const { context } = createSessionOwnerMenuHarness((method) =>
      method === "agent.identity.get"
        ? { agentId: "research:one", name: "Research Assistant", nameSource: "config", avatar: "" }
        : sessionOwnerProfiles("Ada"),
    );
    const agentIdentity = createAgentIdentityCapability(context.gateway);
    const menu = await mountMenu({ context: { ...context, agentIdentity } });
    await openSubmenu(menu, "Assign to…");
    const search = menu.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "Assistant";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await waitForSolid(() => expect(owners(menu)).toHaveLength(0));

    await agentIdentity.ensure(["research:one"]);
    await waitForSolid(() => expect(menu.textContent).toContain("Research Assistant"));
    expect(search.value).toBe("Assistant");
    expect(owners(menu)).toHaveLength(1);
  });

  it("filters the member directory and preserves remove-member selection", async () => {
    const onMemberChange = vi.fn();
    const root = mountPeopleSharing(101, onMemberChange, ["person-100"]);
    flush();
    root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")!.click();
    await waitForSolid(() =>
      expect(root.querySelector(".chat-pane__sharing-panel")?.matches(":popover-open")).toBe(true),
    );
    const search = root.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).not.toBeNull();
    search!.focus();
    search!.value = "Person 0100";
    search!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await waitForFast(() =>
      expect(root.querySelectorAll('[data-value^="member:"]')).toHaveLength(1),
    );
    expect(root.querySelector("input[type='search']")).toBe(search);
    expect(document.activeElement).toBe(search);
    const member = root.querySelector<HTMLButtonElement>('[data-value="member:person-100"]')!;
    expect(member.querySelector(".session-menu__check")).not.toBeNull();
    member.click();
    await waitForFast(() => expect(onMemberChange).toHaveBeenCalledWith("person-100", false));
  });
});
