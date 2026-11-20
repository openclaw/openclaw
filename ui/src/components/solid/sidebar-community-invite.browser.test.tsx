import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { ApplicationContext } from "../../app/context-types.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createCommunityInviteContext } from "../community-invite-state.test-support.ts";
import "../../styles.css";
import "../../../public/themes/absolutely.css";
import "../../../public/themes/tide.css";
import { SidebarCommunityInvite } from "./sidebar-community-invite.tsx";

const root = document.documentElement;

function renderInvite(onDismiss: () => void, mode: "light" | "dark", used = 3) {
  // SAFETY: SidebarCommunityInvite reads only the session-use members supplied by the fixture.
  const fixture = createCommunityInviteContext({ used });
  const context = fixture.context as ApplicationContext;
  const view = render(() => (
    <ApplicationProvider value={context}>
      <div class="sidebar">
        <div class="sidebar-shell">
          <SidebarCommunityInvite onDismiss={onDismiss} mode={mode} />
        </div>
      </div>
    </ApplicationProvider>
  ));
  return Object.assign(view, { fixture });
}
const originalTheme = root.getAttribute("data-theme");
const originalMode = root.getAttribute("data-theme-mode");

afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const [name, value] of [
    ["data-theme", originalTheme],
    ["data-theme-mode", originalMode],
  ] as const) {
    if (value === null) {
      root.removeAttribute(name);
    } else {
      root.setAttribute(name, value);
    }
  }
});

it("stays hidden until the third prompted session", async () => {
  const view = renderInvite(() => {}, "light", 2);
  await vi.waitFor(() => expect(view.fixture.reads).toBe(1));
  await view.fixture.settled();
  expect(view.container.querySelector(".community-invite-card")).toBeNull();
});

it("offers safe community links and dismisses permanently with the keyboard", async () => {
  const dismissed = vi.fn();
  const view = renderInvite(dismissed, "light");
  await expect.element(page.getByText("Pull up a chair.")).toBeInTheDocument();
  const close = page.getByRole("button", { name: "Dismiss and don't show again" });
  const links = [...view.container.querySelectorAll<HTMLAnchorElement>(".invite__cta")];
  expect(links.map((link) => [link.getAttribute("aria-label"), link.href])).toEqual([
    ["Join the OpenClaw community on Reddit", "https://www.reddit.com/r/openclaw/"],
    [
      "Join the OpenClaw community on Discord",
      "https://openclaw.ai/discord?from=openclaw-app-community",
    ],
    ["Follow OpenClaw on X", "https://x.com/openclaw"],
  ]);
  for (const link of links) {
    expect(link.target).toBe("_blank");
    expect(link.rel.split(/\s+/u)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
  }
  close.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(close).not.toBeInTheDocument();
  expect(dismissed).toHaveBeenCalledOnce();
  view.unmount();
  const remounted = renderInvite(dismissed, "light");
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  // A saved dismissal is final: the remount neither reads session use nor shows the card.
  expect(remounted.fixture.queries).toEqual([]);
  expect(remounted.container.querySelector(".community-invite-card")).toBeNull();
});

it("uses the sidebar surface and matching artwork in light and dark themes", async () => {
  for (const theme of ["claw", "absolutely", "tide"]) {
    for (const mode of ["light", "dark"] as const) {
      root.dataset.theme = theme === "claw" ? mode : theme + (mode === "light" ? "-light" : "");
      root.dataset.themeMode = mode;
      const view = renderInvite(() => {}, mode);
      await expect.element(page.getByRole("complementary")).toBeInTheDocument();
      const sidebar = view.container.querySelector<HTMLElement>(".sidebar")!;
      const invite = view.container.querySelector<HTMLElement>(".invite")!;
      expect(getComputedStyle(invite).backgroundColor).toBe(
        getComputedStyle(sidebar).backgroundColor,
      );
      expect(view.container.querySelector(".invite__art")?.getAttribute("src")).toContain(
        `community-invite-${mode}.webp`,
      );
      view.unmount();
    }
  }
});
