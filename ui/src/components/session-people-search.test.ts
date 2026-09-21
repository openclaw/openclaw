/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { renderChatSessionSharing } from "../pages/chat/components/chat-session-sharing.ts";
import { containers, mountMenu, selectMenuValue } from "../test-helpers/session-menu.ts";
import {
  createSessionOwnerMenuHarness,
  sessionOwnerProfiles,
} from "../test-helpers/session-owner-menu.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";

describe("searchable session people", () => {
  it("preserves a query typed while the assignment directory is loading", async () => {
    const pending = createDeferred<ReturnType<typeof sessionOwnerProfiles>>();
    const { context, request } = createSessionOwnerMenuHarness(() => pending.promise);
    const menu = await mountMenu({ context });
    await waitForFast(() => expect(request).toHaveBeenCalledWith("users.list", {}));
    const search = menu.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "Carol";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));

    pending.resolve(sessionOwnerProfiles("Ada", "Bob", "Carol"));
    await waitForFast(() => expect(menu.textContent).toContain("Carol"));
    expect(search.value).toBe("Carol");
    expect(menu.querySelectorAll('[value^="assign-owner:"]')).toHaveLength(1);
  });

  it.each([21, 1000])(
    "searches the whole %i-person directory without rendering it all",
    async (count) => {
      const names = Array.from(
        { length: count },
        (_, index) => `Person ${String(index).padStart(4, "0")}`,
      );
      const { context, request } = createSessionOwnerMenuHarness(() =>
        sessionOwnerProfiles(...names),
      );
      const onAction = vi.fn();
      const menu = await mountMenu({ context, onAction });
      await waitForFast(() => expect(request).toHaveBeenCalledWith("users.list", {}));
      await waitForFast(() => expect(menu.textContent).toContain(names[0]));
      expect(menu.querySelectorAll('[value^="assign-owner:"]').length).toBeLessThanOrEqual(20);
      const search = menu.querySelector<HTMLInputElement>('input[type="search"]');
      expect(search).not.toBeNull();
      search!.value = names.at(-1)!;
      search!.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await waitForFast(() =>
        expect(menu.querySelectorAll('[value^="assign-owner:"]')).toHaveLength(1),
      );
      const row = menu.querySelector<HTMLElement>('[value^="assign-owner:"]')!;
      expect(row.textContent).toContain(names.at(-1));
      selectMenuValue(menu, row.getAttribute("value")!);
      expect(onAction).toHaveBeenCalledWith({
        kind: "assign-owner",
        owner: { type: "human", id: `profile-person-${String(count - 1).padStart(4, "0")}` },
      });
    },
  );

  it("searches beyond the first member page and preserves remove-member selection", async () => {
    const onMemberChange = vi.fn();
    const root = document.createElement("div");
    containers.push(root);
    document.body.append(root);
    render(
      renderChatSessionSharing({
        session: { key: "agent:main:people", kind: "direct", updatedAt: 1, sharingRole: "owner" },
        state: {
          loading: false,
          result: {
            sessionKey: "agent:main:people",
            role: "owner",
            allowedVisibilities: ["shared"],
            members: [{ identityId: "person-999", addedBy: "owner", addedAt: 1 }],
            identities: Array.from({ length: 1000 }, (_, i) => ({
              type: "human" as const,
              id: `person-${i}`,
              label: `Person ${String(i).padStart(4, "0")}`,
            })),
          },
        },
        onOpen: vi.fn(),
        onVisibilityChange: vi.fn(),
        onMemberChange,
      }),
      root,
    );
    expect(root.querySelectorAll('[value^="member:"]').length).toBeLessThanOrEqual(20);
    const search = root.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).not.toBeNull();
    search!.value = "Person 0999";
    search!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await waitForFast(() => expect(root.querySelectorAll('[value^="member:"]')).toHaveLength(1));
    expect(root.querySelector('[value="member:person-999"] .session-menu__check')).not.toBeNull();
    root
      .querySelector("wa-dropdown")
      ?.dispatchEvent(
        new CustomEvent("wa-select", { detail: { item: { value: "member:person-999" } } }),
      );
    expect(onMemberChange).toHaveBeenCalledWith("person-999", false);
  });
});
