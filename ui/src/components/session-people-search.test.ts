/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { renderChatSessionSharing } from "../pages/chat/components/chat-session-sharing.ts";
import { containers, mountMenu } from "../test-helpers/session-menu.ts";
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

  it("filters the member directory and preserves remove-member selection", async () => {
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
            members: [{ identityId: "person-100", addedBy: "owner", addedAt: 1 }],
            identities: Array.from({ length: 101 }, (_, i) => ({
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
    const search = root.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).not.toBeNull();
    search!.value = "Person 0100";
    search!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await waitForFast(() => expect(root.querySelectorAll('[value^="member:"]')).toHaveLength(1));
    expect(root.querySelector('[value="member:person-100"] .session-menu__check')).not.toBeNull();
    root
      .querySelector("wa-dropdown")
      ?.dispatchEvent(
        new CustomEvent("wa-select", { detail: { item: { value: "member:person-100" } } }),
      );
    expect(onMemberChange).toHaveBeenCalledWith("person-100", false);
  });
});
