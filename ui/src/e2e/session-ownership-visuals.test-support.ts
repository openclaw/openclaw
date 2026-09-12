import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { expect } from "vitest";
import {
  takeControlUiElementScreenshot,
  takeControlUiViewportScreenshot,
  waitForControlUiProofSurface,
} from "../test-helpers/control-ui-e2e-screenshot.ts";

export const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

// Pre-compact baseline: 18px faces in a 28px stack, not the earlier 14px/20px predecessor.
export const preCompactOwnerStackStyles = `
          .session-owner-stack {
            width: 28px; flex: 0 1 auto; align-items: center; justify-content: flex-end;
          }
          .session-owner-stack__back { top: auto; left: 0; }
          .session-owner-stack__back .viewer-avatar,
          .session-owner-stack__overflow { width: 18px; height: 18px; font-size: 8px; }
          .session-owner-stack__front {
            position: relative; top: auto; left: auto; width: 18px; height: 18px;
            border-color: hsl(var(--owner-hue) 52% 18% / 0.9);
            box-shadow: 0 1px 2px rgb(0 0 0 / 0.24); font-size: 10px;
          }
`;

export function createSessionOwnershipProofContext(
  owner: { readonly artifactDir: string; readonly browser: Browser },
  directory: "drafts-ux" | "session-owner-stack",
) {
  const viewport = { height: 800, width: 1200 };
  return owner.browser.newContext({
    viewport,
    ...(captureUiProofEnabled
      ? { recordVideo: { dir: path.join(owner.artifactDir, directory), size: viewport } }
      : {}),
  });
}

type AvatarFixture = {
  id: string;
  background: string;
  label: string;
};

export async function routeAvatarFixtures(page: Page, fixtures: readonly AvatarFixture[]) {
  await Promise.all(
    fixtures.map(({ id, background, label }) =>
      page.route(`**/api/users/${id}/avatar*`, (route) =>
        route.fulfill({
          // Static input assets must not depend on browser screenshot availability.
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="${background}"/><text x="32" y="32" text-anchor="middle" dominant-baseline="central" fill="white" style="font:700 26px system-ui">${label}</text></svg>`,
          contentType: "image/svg+xml",
          status: 200,
        }),
      ),
    ),
  );
}

export async function avatarLabelCenterDelta(row: Locator) {
  return row.evaluate((element) => {
    const avatar = element.querySelector<HTMLElement>("openclaw-session-owner-chip");
    const label = element.querySelector<HTMLElement>(".session-menu__text");
    if (!avatar || !label) {
      throw new Error("expected a complete owner filter row");
    }
    const avatarBounds = avatar.getBoundingClientRect();
    const labelBounds = label.getBoundingClientRect();
    return Math.abs(
      avatarBounds.top + avatarBounds.height / 2 - (labelBounds.top + labelBounds.height / 2),
    );
  });
}

export async function captureUiProof(
  owner: { readonly artifactDir: string },
  surface: Locator,
  fileName: string,
  content: readonly Locator[],
) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(path.join(owner.artifactDir, "drafts-ux"), { recursive: true });
  await writeFile(
    path.join(owner.artifactDir, "drafts-ux", fileName),
    await takeControlUiViewportScreenshot(surface.page(), surface, content),
  );
}

export async function captureSessionOwnerProof(
  owner: { readonly artifactDir: string },
  page: Page,
  fileName: string,
) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(path.join(owner.artifactDir, "session-owner-stack"), { recursive: true });
  await writeFile(
    path.join(owner.artifactDir, "session-owner-stack", fileName),
    await takeControlUiElementScreenshot(page, page.locator(".sidebar-sessions"), [
      page.locator(".sidebar-recent-session").first(),
    ]),
  );
}

export async function captureSessionOwnerPageProof(
  owner: { readonly artifactDir: string },
  surface: Locator,
  fileName: string,
  content: readonly Locator[],
) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(path.join(owner.artifactDir, "session-owner-stack"), { recursive: true });
  await writeFile(
    path.join(owner.artifactDir, "session-owner-stack", fileName),
    await takeControlUiViewportScreenshot(surface.page(), surface, content),
  );
}

export async function openSidebarSortMenu(page: Page) {
  const filterAndSort = page.getByRole("button", { name: "Filter & sort" });
  await expect.poll(() => filterAndSort.count(), { timeout: 2_000 }).toBe(1);
  await filterAndSort.click();
  const menu = page.locator(".sidebar-session-sort-menu");
  await waitForControlUiProofSurface(menu.locator('[part="menu"]'), [
    menu.locator("wa-dropdown-item").first(),
  ]);
  return menu;
}
