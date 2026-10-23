import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
/* @vitest-environment jsdom */
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid as waitForFast } from "../../test-helpers/solid-settle.ts";
import { ProfileHero, type ProfileHeroProps } from "./profile-hero.tsx";
import { createConnectedContext, mountProfilePage } from "./profile-page.test-support.tsx";
let unmount: (() => void) | undefined;
function mountHero(props: ProfileHeroProps, container: HTMLElement) {
  unmount?.();
  unmount = mountSolid(() => <ProfileHero {...props} />, { container }).unmount;
  flush();
}

const container = document.createElement("div");
afterEach(() => {
  document.body.replaceChildren();
});

it("keeps the connected person's hero independent of the default agent and live name updates", async () => {
  const props = {
    row: { id: "clipper", name: "Clipper" },
    identity: null,
    user: { id: "person-1", name: "Ada", email: "ada@example.test" },
  };
  mountHero(props, container);
  expect(container.querySelector(".profile-hero__name")?.textContent).toBe("Ada");
  expect(container.querySelector(".profile-hero__handle")?.textContent).toContain(
    "ada@example.test",
  );
  expect(container.textContent).not.toContain("Clipper");

  mountHero({ ...props, user: { ...props.user, name: "Ada Lovelace" } }, container);
  expect(container.querySelector(".profile-hero__name")?.textContent).toBe("Ada Lovelace");

  mountHero({ ...props, user: null }, container);
  expect(container.querySelector(".profile-hero__name")?.textContent).toBe("Clipper");
  expect(container.querySelector(".profile-hero__handle")?.textContent).toContain("@clipper");
  await waitForFast(() =>
    expect(
      container.querySelector(".profile-hero__avatar .identity-avatar__agent-face"),
    ).not.toBeNull(),
  );

  mountHero({ ...props, user: { id: "gateway-owner" } }, container);
  expect(container.querySelector(".profile-hero__name")?.textContent).toBe(t("nav.owner"));
});

it("honors a live name clear while the profile editor still holds the fetched name", async () => {
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

  harness.context.gateway.updateSelfUser?.({ name: undefined });
  await waitForFast(() =>
    expect(page.querySelector(".profile-hero__name")?.textContent).toBe("ada@example.test"),
  );
});
