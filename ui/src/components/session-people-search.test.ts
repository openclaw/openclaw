/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { mountMenu, openSubmenu } from "../test-helpers/session-menu.ts";
import {
  createSessionOwnerMenuHarness,
  sessionOwnerProfiles,
} from "../test-helpers/session-owner-menu.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";

const owners = (root: ParentNode) => root.querySelectorAll('[data-value^="assign-owner:"]');
function searchFor(search: HTMLInputElement, value: string) {
  search.value = value;
  search.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

it("preserves a loading query until the connection changes", async () => {
  const pending = createDeferred<ReturnType<typeof sessionOwnerProfiles>>();
  const { context, request, publish } = createSessionOwnerMenuHarness(() => pending.promise);
  const menu = await mountMenu({ context });
  await openSubmenu(menu, "Assign to…");
  await waitForFast(() => expect(request).toHaveBeenCalledWith("users.list", {}));
  const search = menu.querySelector<HTMLInputElement>('input[type="search"]')!;
  searchFor(search, "Carol");

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
  searchFor(search, "Assistant");
  await waitForSolid(() => expect(owners(menu)).toHaveLength(0));

  await agentIdentity.ensure(["research:one"]);
  await waitForSolid(() => expect(menu.textContent).toContain("Research Assistant"));
  expect(search.value).toBe("Assistant");
  expect(owners(menu)).toHaveLength(1);
});
