import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
/* @vitest-environment jsdom */
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid as waitForFast } from "../../test-helpers/solid-settle.ts";
import { ProfileHero } from "./profile-hero.tsx";
import { createConnectedContext, mountProfilePage } from "./profile-page.test-support.tsx";
let unmount: (() => void) | undefined;
function mountHero(props: Parameters<typeof ProfileHero>[0], container: HTMLElement) {
  unmount?.();
  unmount = mountSolid(() => <ProfileHero {...props} />, { container }).unmount;
  flush();
}

const container = document.createElement("div");
afterEach(() => {
  document.body.replaceChildren();
});

it("shows the default agent when the connection has no person", async () => {
  mountHero({ row: { id: "clipper", name: "Clipper" }, identity: null }, container);
  expect(container.querySelector(".profile-hero__name")?.textContent).toBe("Clipper");
  expect(container.querySelector(".profile-hero__handle")?.textContent).toContain("@clipper");
  await waitForFast(() =>
    expect(
      container.querySelector(".profile-hero__avatar .identity-avatar__agent-face"),
    ).not.toBeNull(),
  );
});

it("leaves a person's name and avatar to the identity rows", async () => {
  const profile = {
    id: "person-1",
    displayName: "Ada",
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 2,
    emails: ["ada@example.test"],
    githubIdentity: null,
    hasAvatar: false,
  };
  const request = vi.fn(async (method: string) => {
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: profile.id, accounts: [], links: [] };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: profile.id,
    name: "Ada",
    email: "ada@example.test",
  });
  const page = mountProfilePage(harness.context);
  await waitForFast(() =>
    expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe("Ada"),
  );

  expect(page.querySelector(".profile-hero")).toBeNull();
  expect(page.querySelector("#settings-profile-identity openclaw-viewer-avatar")).not.toBeNull();
});
