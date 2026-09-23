import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { BUILTIN_THEME_IDS } from "../../../packages/gateway-protocol/src/theme-ids.ts";
import "../test-helpers/load-styles.ts";
import { resolveTheme, syncThemePaletteStylesheet, type ThemeName } from "../app/theme.ts";
import { TYPEFACES, resolveTypefaces, syncTypefaceStylesheets } from "../app/typography.ts";
import {
  readAvatarGatewayContext,
  setAvatarGatewayOrigin,
} from "../lib/identity-avatar-context.ts";
import { renderSessionLeadingState } from "./session-leading-indicator.ts";
import "./session-owner-chip.ts";

function renderedLuminance(...backgrounds: string[]): number {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  for (const color of backgrounds) {
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
  }
  const channels = context.getImageData(0, 0, 1, 1).data;
  expect(channels[3]).toBe(255);
  return pixelLuminance(channels);
}

function pixelLuminance(channels: Uint8ClampedArray): number {
  return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
    const value = channels[index]! / 255;
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return sum + linear * weight;
  }, 0);
}

async function paintedCounterLuminance(face: HTMLElement): Promise<number> {
  const base64 = await page.elementLocator(face).screenshot({ save: false });
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  // Sample below the text, clear of the unread badge and circular border.
  const scale = image.height / face.getBoundingClientRect().height;
  return pixelLuminance(
    context.getImageData(Math.floor(image.width / 2), Math.floor(image.height - 3 * scale), 1, 1)
      .data,
  );
}

function contrastRatio(first: number, second: number): number {
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const originalTheme = document.documentElement.getAttribute("data-theme-mode");
const originalPalette = document.documentElement.getAttribute("data-theme");
const originalAvatarGatewayContext = readAvatarGatewayContext();

beforeEach(() => {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  // These profiles have no saved image; resolve their fallback through the Gateway loader.
  setAvatarGatewayOrigin(location.origin);
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (
      url === `${location.origin}/api/users/profile-ada/avatar` ||
      url === `${location.origin}/api/users/profile-bob/avatar`
    ) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return nativeFetch(input, init);
  });
});

async function applyTheme(theme: ThemeName, mode: "light" | "dark") {
  await new Promise<void>((resolve) => {
    syncThemePaletteStylesheet(theme, resolve);
  });
  document.documentElement.dataset.theme = resolveTheme(theme, mode);
  document.documentElement.dataset.themeMode = mode;
  const typefaces = resolveTypefaces(theme);
  syncTypefaceStylesheets(typefaces);
  await expect
    .poll(
      () =>
        document.querySelector<HTMLLinkElement>(`#openclaw-typeface-${typefaces.ui}`)?.sheet !=
        null,
    )
    .toBe(true);
  await document.fonts.load(`700 9px ${TYPEFACES[typefaces.ui].stack}`, "AB+241");
}

async function expectCenteredInk(face: HTMLElement) {
  const base64 = await page.elementLocator(face).screenshot({ save: false });
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = getComputedStyle(face).color;
  context.fillRect(0, 0, 1, 1);
  const foreground = context.getImageData(0, 0, 1, 1).data;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  let left = image.width,
    right = -1,
    top = image.height,
    bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      // Exclude the circular edge and the peer behind this topmost face.
      if (Math.hypot(x + 0.5 - image.width / 2, y + 0.5 - image.height / 2) > image.width * 0.375) {
        continue;
      }
      const offset = (y * image.width + x) * 4;
      if (
        [0, 1, 2].every(
          (channel) => Math.abs(pixels[offset + channel]! - foreground[channel]!) <= 40,
        )
      ) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  expect(right).toBeGreaterThan(left);
  expect(bottom).toBeGreaterThan(top);
  const scale = image.width / Number.parseFloat(getComputedStyle(face).width);
  expect(
    Math.abs((left + right + 1 - image.width) / (2 * scale)),
    "painted text x",
  ).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs((top + bottom + 1 - image.height) / (2 * scale)),
    "painted text y",
  ).toBeLessThanOrEqual(0.5);
}
const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

afterEach(() => {
  document.body.replaceChildren();
  setAvatarGatewayOrigin(
    originalAvatarGatewayContext.origin,
    originalAvatarGatewayContext.authTokens,
    originalAvatarGatewayContext.resourceBasePath,
  );
  vi.restoreAllMocks();
  if (originalPalette === null) {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", originalPalette);
  }
  if (originalTheme === null) {
    document.documentElement.removeAttribute("data-theme-mode");
  } else {
    document.documentElement.setAttribute("data-theme-mode", originalTheme);
  }
});

async function mountOwnerChip(params: {
  participants?: readonly SessionParticipant[];
  participantCount?: number;
}) {
  const chip = document.createElement("openclaw-session-owner-chip");
  chip.owner = { type: "human", id: "profile-ada", label: "Ada" };
  chip.size = "row";
  chip.participants = params.participants ?? [];
  chip.participantCount = params.participantCount ?? chip.participants.length;
  document.body.append(chip);
  await chip.updateComplete;
  return chip;
}

describe.skipIf(!hasBrowserLayout)("session owner stack layout", () => {
  it.each(
    BUILTIN_THEME_IDS.flatMap((theme) =>
      (["light", "dark"] as const).flatMap((mode) =>
        (theme === "claw" ? [2, 3, 5, 12, 13] : [12]).flatMap((ownerCount) =>
          (theme === "claw"
            ? ["present", "running", "away", "unread"]
            : ["present", "away"]
          ).flatMap((presence) =>
            (presence === "present" && ownerCount === 12 ? [false, true] : [false]).map(
              (pinned) => ({ theme, mode, ownerCount, presence, pinned }),
            ),
          ),
        ),
      ),
    ),
  )(
    "keeps $ownerCount owners in an equal pair in $theme $mode while $presence (pinned=$pinned)",
    async ({ theme, mode, ownerCount, presence, pinned }) => {
      await applyTheme(theme, mode);
      const sidebar = document.createElement("aside");
      sidebar.className = "sidebar";
      const shell = document.createElement("div");
      shell.className = "sidebar-shell";
      const sessions = document.createElement("section");
      sessions.className = "sidebar-sessions sidebar-recent-sessions";
      sessions.classList.toggle("sidebar-zone-entry", pinned);
      shell.append(sessions);
      sidebar.append(shell);
      document.body.append(sidebar);
      render(
        html`<div class="sidebar-recent-session">
          <a class="sidebar-recent-session__link">
            <span class="sidebar-session-indicator"
              >${
                renderSessionLeadingState(
                  {
                    key: "agent:main:shared",
                    label: "Shared session",
                    renameValue: "Shared session",
                    active: false,
                    visuallyActive: false,
                    hasActiveRun: presence === "running",
                    modelSelectionLocked: false,
                    pinned: false,
                    pinnable: true,
                    cloudWorkerStopAction: null,
                    hasAutomation: false,
                    unread: presence === "unread",
                    attention: { kind: "none" },
                    childSessionKeys: [],
                    children: [],
                    isChild: false,
                    loadingChildren: false,
                    containsActiveDescendant: false,
                    runningChildCount: 0,
                    failedChildCount: 0,
                    participants: [
                      { identity: { type: "profile", id: "profile-bob" }, label: "Bob" },
                    ],
                    participantCount: ownerCount - 1,
                  },
                  {
                    type: "human",
                    id: "profile-ada",
                    identity: { type: "profile", id: "profile-ada" },
                    label: "Ada",
                  },
                  "owned",
                  presence === "away" ? false : undefined,
                ).leadingIndicator
              }</span
            >
            <span class="sidebar-recent-session__title">Shared session</span>
          </a>
        </div>`,
        sessions,
      );
      const row = sidebar.querySelector<HTMLElement>(".sidebar-recent-session")!;
      // Contrast is measured at each interaction endpoint, outside its transition.
      row.style.transition = "none";
      const chip = sidebar.querySelector("openclaw-session-owner-chip")!;
      await chip.updateComplete;
      await Promise.all(
        [...chip.querySelectorAll("openclaw-viewer-avatar")].map((avatar) => avatar.updateComplete),
      );
      await expect
        .poll(() =>
          [...chip.querySelectorAll(".viewer-avatar")].map((avatar) =>
            avatar.getAttribute("data-avatar-state"),
          ),
        )
        .not.toContain("pending");
      const stack = chip.querySelector<HTMLElement>(".session-owner-stack")!;
      const primary = chip.querySelector<HTMLElement>(".session-owner-stack__front")!;
      const peer = chip.querySelector<HTMLElement>(
        ownerCount === 2
          ? ".session-owner-stack__back .viewer-avatar"
          : ".session-owner-stack__overflow",
      )!;
      expect(primary.getAttribute("aria-label")).toBe("Owned by Ada");
      expect(primary.textContent?.trim()).toBe("A");
      expect(stack.getAttribute("aria-label")).toBe(
        ownerCount === 2 ? "Owned by Ada · with Bob" : `Owned by Ada · +${ownerCount - 1} more`,
      );
      for (const state of ["idle", "hover", "active", "selected"]) {
        if (state === "hover") {
          await userEvent.hover(row);
        } else if (state === "idle" || state === "active") {
          await userEvent.unhover(row);
        }
        row.classList.toggle("sidebar-recent-session--active", state === "active");
        row.classList.toggle("sidebar-recent-session--selected", state === "selected");
        expect(row.matches(":hover")).toBe(state === "hover");
        const primaryBounds = primary.getBoundingClientRect();
        const peerBounds = peer.getBoundingClientRect();
        const stackBounds = stack.getBoundingClientRect();
        expect([stackBounds.width, stackBounds.height]).toEqual([28, 20]);
        for (const bounds of [primaryBounds, peerBounds]) {
          expect([bounds.width, bounds.height]).toEqual([18, 18]);
          expect(bounds.top).toBe(stackBounds.top + 1);
          expect(bounds.left).toBeGreaterThanOrEqual(stackBounds.left);
          expect(bounds.right).toBeLessThanOrEqual(stackBounds.right);
        }
        expect(Math.abs(primaryBounds.left - peerBounds.left)).toBe(10);
        expect(
          Math.min(primaryBounds.right, peerBounds.right) -
            Math.max(primaryBounds.left, peerBounds.left),
        ).toBe(8);
        expect(getComputedStyle(primary).fontSize).toBe(getComputedStyle(peer).fontSize);
        const primaryFace = primary.querySelector<HTMLElement>(".viewer-avatar > span")!;
        const paintedPrimary = primaryFace.getBoundingClientRect();
        expect([paintedPrimary.width, paintedPrimary.height]).toEqual([16, 16]);
        expect(getComputedStyle(primary).opacity).toBe(presence === "away" ? "0.45" : "1");
        expect(getComputedStyle(peer).opacity).toBe(
          ownerCount > 2 && presence === "away" ? getComputedStyle(primary).opacity : "1",
        );
        if (ownerCount > 2) {
          expect(getComputedStyle(peer).filter).toBe(getComputedStyle(primary).filter);
        }
        if (presence === "running") {
          const traceBounds = row.querySelector(".session-glyph__trace")!.getBoundingClientRect();
          expect(traceBounds.left).toBe(stackBounds.left - 2);
          expect(traceBounds.right).toBe(stackBounds.right + 2);
        }
        if (presence === "unread") {
          const badge = row.querySelector(".session-glyph__badge--unread")!;
          const badgeBounds = badge.getBoundingClientRect();
          for (const fraction of [0.5, 0.75]) {
            expect(
              document.elementFromPoint(
                badgeBounds.left + badgeBounds.width / 2,
                badgeBounds.top + badgeBounds.height * fraction,
              ),
            ).toBe(badge);
          }
        }
        if (ownerCount === 2) {
          expect(peerBounds.left).toBe(stackBounds.left);
          const paintedPeer = peer.querySelector("span")!.getBoundingClientRect();
          expect([paintedPeer.width, paintedPeer.height]).toEqual([
            paintedPrimary.width,
            paintedPrimary.height,
          ]);
          continue;
        }
        expect(primaryBounds.left).toBe(stackBounds.left);
        expect(peerBounds.right).toBe(stackBounds.right);
        expect(peer.textContent).toBe(`+${ownerCount - 1}`);
        const textRange = document.createRange();
        textRange.selectNodeContents(peer);
        const textBounds = textRange.getBoundingClientRect();
        expect(textBounds.left).toBeGreaterThanOrEqual(peerBounds.left + 1);
        expect(textBounds.right).toBeLessThanOrEqual(peerBounds.right - 1);
        for (const x of [textBounds.left + 0.5, textBounds.right - 0.5]) {
          expect(
            peer.contains(document.elementFromPoint(x, textBounds.top + textBounds.height / 2)),
          ).toBe(true);
        }
        const style = getComputedStyle(peer);
        expect(style.borderTopWidth).toBe("1px");
        const rowBackground = [
          getComputedStyle(sidebar).backgroundColor,
          getComputedStyle(row).backgroundColor,
        ];
        const rowLuminance = renderedLuminance(...rowBackground);
        if (presence === "away") {
          continue;
        }
        const counterLuminance = await paintedCounterLuminance(peer);
        const textLuminance = renderedLuminance(style.color);
        expect(
          contrastRatio(counterLuminance, rowLuminance),
          `${theme} ${state} surface`,
        ).toBeGreaterThanOrEqual(1.3);
        expect(
          contrastRatio(textLuminance, counterLuminance),
          `${theme} ${state} text`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      if (theme === "claw" && presence === "away" && ownerCount === 3) {
        chip.viewingNow = true;
        await chip.updateComplete;
        await expect
          .poll(() =>
            [primary, peer].map((face) => ({
              opacity: getComputedStyle(face).opacity,
              filter: getComputedStyle(face).filter,
            })),
          )
          .toEqual([
            { opacity: "1", filter: "none" },
            { opacity: "1", filter: "none" },
          ]);
      }
      if (presence === "present") {
        row.classList.remove("sidebar-recent-session--selected");
        row.style.zoom = "4";
        await expectCenteredInk(ownerCount === 2 ? primary : peer);
      }
    },
  );

  it.each(
    (["light", "dark"] as const).flatMap((mode) =>
      (["row", "header"] as const).flatMap((size) =>
        [false, true].map((profile) => ({ mode, size, profile })),
      ),
    ),
  )(
    "centers a single $size initial in $mode with profile=$profile",
    async ({ mode, size, profile }) => {
      await applyTheme("claw", mode);
      const chip = await mountOwnerChip({});
      chip.size = size;
      if (profile) {
        chip.owner = { ...chip.owner!, identity: { type: "profile", id: "profile-ada" } };
      }
      await chip.updateComplete;
      await Promise.all(
        [...chip.querySelectorAll("openclaw-viewer-avatar")].map((avatar) => avatar.updateComplete),
      );
      chip.style.zoom = "4";
      await expectCenteredInk(chip.querySelector<HTMLElement>(".session-owner-chip")!);
    },
  );

  it("keeps the single-owner row avatar at its established size", async () => {
    const chip = await mountOwnerChip({});
    const owner = chip.querySelector<HTMLElement>(".session-owner-chip--row");
    if (!owner) {
      throw new Error("expected single owner row avatar");
    }
    const bounds = owner.getBoundingClientRect();
    expect([bounds.width, bounds.height]).toEqual([20, 20]);
    expect(chip.querySelector(".session-owner-stack")).toBeNull();
  });

  it.each(
    ["light", "dark"].flatMap((theme) =>
      [0, 1, 2].map((participantCount) => ({ theme, participantCount })),
    ),
  )(
    "uses a thin cutout only for stacked owners in $theme with $participantCount participants",
    async ({ theme, participantCount }) => {
      document.documentElement.setAttribute("data-theme-mode", theme);
      const sidebar = document.createElement("aside");
      sidebar.className = "sidebar";
      document.body.append(sidebar);
      const chip = await mountOwnerChip({
        participantCount,
        participants: [{ identity: { type: "profile", id: "profile-bob" }, label: "Bob" }],
      });
      const row = document.createElement("div");
      row.className = "sidebar-recent-session";
      row.style.transition = "none";
      sidebar.append(row);
      row.append(chip);
      const front = chip.querySelector<HTMLElement>(".session-owner-chip")!;
      if (participantCount === 0) {
        expect(getComputedStyle(front).borderTopWidth).toBe("0px");
        expect(getComputedStyle(front).boxShadow).toBe("none");
        return;
      }
      const stack = chip.querySelector<HTMLElement>(".session-owner-stack")!;
      for (const selected of [false, true]) {
        row.classList.toggle("sidebar-recent-session--selected", selected);
        await expect
          .poll(() =>
            [getComputedStyle(stack, "::before"), getComputedStyle(stack, "::after")].map(
              (cutout) => ({
                width: cutout.borderTopWidth,
                matchesRow: cutout.borderTopColor === getComputedStyle(row).backgroundColor,
              }),
            ),
          )
          .toEqual([
            { width: "1px", matchesRow: true },
            { width: "1px", matchesRow: true },
          ]);
      }
    },
  );
});
