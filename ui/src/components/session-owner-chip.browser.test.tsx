import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { BUILTIN_THEME_IDS } from "../../../packages/gateway-protocol/src/theme-ids.ts";
import "../test-helpers/load-styles.ts";
import { resolveTheme, syncThemePaletteStylesheet, type ThemeName } from "../app/theme.ts";
import { TYPEFACES, resolveTypefaces, syncTypefaceStylesheets } from "../app/typography.ts";
import { runningRow } from "../test-helpers/app-sidebar-session-narration.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { SessionOwnerChip } from "./solid/session-owner-chip.tsx";
import { renderSessionLeadingState } from "./solid/session-presentation.tsx";

const participants = [{ identity: { type: "profile" as const, id: "profile-bob" }, label: "Bob" }];
const ada = { type: "human" as const, id: "profile-ada", label: "Ada" };
const identity = { type: "profile" as const, id: ada.id };
const modes = ["light", "dark"] as const;
function appearance(face: Element) {
  const { opacity, filter } = getComputedStyle(face);
  return { opacity, filter };
}
function dimensions(face: Element) {
  const { width, height } = face.getBoundingClientRect();
  return [width, height];
}

function canvasContext(width = 1, height = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext("2d")!;
}
function renderedLuminance(...backgrounds: string[]): number {
  const context = canvasContext();
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

async function captureFace(face: HTMLElement) {
  const base64 = await page.elementLocator(face).screenshot({ save: false });
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();
  const context = canvasContext(image.width, image.height);
  context.drawImage(image, 0, 0);
  return { image, context, bounds: face.getBoundingClientRect() };
}

function paintedCounterLuminance(
  face: HTMLElement,
  { image, context, bounds }: Awaited<ReturnType<typeof captureFace>>,
): number {
  // Sample below the text, clear of the unread badge and circular border.
  const scale = image.width / bounds.width;
  const rect = face.getBoundingClientRect();
  return pixelLuminance(
    context.getImageData(
      Math.floor((rect.left + rect.width / 2 - bounds.left) * scale),
      Math.floor((rect.bottom - 3 - bounds.top) * scale),
      1,
      1,
    ).data,
  );
}

function cutouts(stack: HTMLElement, row: HTMLElement) {
  return ["::before", "::after"].map((pseudo) => {
    const style = getComputedStyle(stack, pseudo);
    return {
      width: style.borderTopWidth,
      matchesRow: style.borderTopColor === getComputedStyle(row, "::after").backgroundColor,
    };
  });
}
function contrastRatio(first: number, second: number): number {
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const originalAttributes = ["data-theme-mode", "data-theme"].map(
  (name) => [name, document.documentElement.getAttribute(name)] as const,
);
function sidebarFixture(pinned: boolean) {
  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";
  sidebar.innerHTML = `<div class="sidebar-shell"><section class="sidebar-sessions sidebar-recent-sessions${pinned ? " sidebar-zone-entry" : ""}">
    <div class="sidebar-recent-session"><a class="sidebar-recent-session__link">
      <span class="sidebar-session-indicator"></span><span class="sidebar-recent-session__title">Shared session</span>
    </a></div></section></div>`;
  document.body.append(sidebar);
  return {
    sidebar,
    row: sidebar.querySelector<HTMLElement>(".sidebar-recent-session")!,
    indicator: sidebar.querySelector<HTMLElement>(".sidebar-session-indicator")!,
  };
}
async function applyTheme(theme: ThemeName, mode: "light" | "dark") {
  await new Promise<void>((resolve) => {
    syncThemePaletteStylesheet(theme, resolve);
  });
  document.documentElement.dataset.theme = resolveTheme(theme, mode);
  document.documentElement.dataset.themeMode = mode;
  const typefaces = resolveTypefaces(theme);
  syncTypefaceStylesheets(typefaces);
  const stylesheet = document.querySelector<HTMLLinkElement>(`#openclaw-typeface-${typefaces.ui}`)!;
  if (!stylesheet.sheet) {
    await new Promise<void>((resolve, reject) => {
      stylesheet.addEventListener("load", () => resolve(), { once: true });
      stylesheet.addEventListener("error", () => reject(new Error("Typeface stylesheet failed")), {
        once: true,
      });
    });
  }
  expect(stylesheet.sheet).not.toBeNull();
  await document.fonts.load(`700 9px ${TYPEFACES[typefaces.ui].stack}`, "AB+241");
}

async function expectCenteredInk(face: HTMLElement) {
  const { image, context } = await captureFace(face);
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
  const scale = image.width / Number.parseFloat(getComputedStyle(face).width);
  for (const [start, end, extent] of [
    [left, right, image.width],
    [top, bottom, image.height],
  ] as const) {
    expect(end).toBeGreaterThan(start);
    expect(Math.abs((start + end + 1 - extent) / (2 * scale))).toBeLessThanOrEqual(0.5);
  }
}
const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

afterEach(() => {
  document.body.replaceChildren();
  for (const [name, value] of originalAttributes) {
    if (value === null) {
      document.documentElement.removeAttribute(name);
    } else {
      document.documentElement.setAttribute(name, value);
    }
  }
});

async function readyAvatars(chip: HTMLElement) {
  flush();
  await expect
    .poll(() =>
      [...chip.querySelectorAll<HTMLElement>(".viewer-avatar")].map((a) => a.dataset.avatarState),
    )
    .not.toContain("pending");
}

describe.skipIf(!hasBrowserLayout)("session owner stack layout", () => {
  it.each(
    BUILTIN_THEME_IDS.flatMap((theme) =>
      modes.flatMap((mode) =>
        (theme === "claw" ? [2, 3, 5, 12, 13] : [12]).flatMap((ownerCount) =>
          // Run/unread share fixed geometry; retain the avatar pair and widest overflow.
          (theme === "claw" && (ownerCount === 2 || ownerCount === 13)
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
    "lays out $ownerCount owners: $theme/$mode, $presence, pinned=$pinned",
    async ({ theme, mode, ownerCount, presence, pinned }) => {
      await applyTheme(theme, mode);
      const { sidebar, row: firstRow } = sidebarFixture(pinned);
      const rowMarkup = firstRow.innerHTML;
      const rows = ["idle", "hover", "active", "selected"].map((state, index) => {
        const row = index === 0 ? firstRow : document.createElement("div");
        if (index > 0) {
          row.className = firstRow.className;
          row.innerHTML = rowMarkup;
          firstRow.parentElement!.append(row);
        }
        // Measure each interaction endpoint outside its transition.
        row.style.transition = "none";
        row.classList.toggle("sidebar-recent-session--active", state === "active");
        row.classList.toggle("sidebar-recent-session--selected", state === "selected");
        const [ownerViewing, setOwnerViewing] = createSignal<boolean | undefined>(
          presence === "away" ? false : undefined,
        );
        mountSolid(
          () =>
            renderSessionLeadingState({
              session: {
                ...runningRow("agent:main:shared"),
                label: "Shared session",
                renameValue: "Shared session",
                hasActiveRun: presence === "running",
                unread: presence === "unread",
                participants,
                participantCount: ownerCount - 1,
              },
              ownerActor: { ...ada, identity },
              attribution: "owned",
              get ownerViewing() {
                return ownerViewing();
              },
            }).leadingIndicator,
          { container: row.querySelector<HTMLElement>(".sidebar-session-indicator")! },
        );
        const chip = row.querySelector<HTMLElement>("openclaw-session-owner-chip")!;
        const stack = chip.querySelector<HTMLElement>(".session-owner-stack")!;
        const primary = chip.querySelector<HTMLElement>(".session-owner-stack__front")!;
        const peer = chip.querySelector<HTMLElement>(
          ownerCount === 2
            ? ".session-owner-stack__back .viewer-avatar"
            : ".session-owner-stack__overflow",
        )!;
        return { state, row, stack, primary, peer, setOwnerViewing };
      });
      await readyAvatars(sidebar);
      await userEvent.hover(rows[1]!.row, { force: true });
      // One real browser capture contains all four states; sample each counter's pixels below.
      const capture = ownerCount > 2 && presence !== "away" ? await captureFace(sidebar) : null;
      for (const { state, row, stack, primary, peer } of rows) {
        expect(primary.getAttribute("aria-label")).toBe("Owned by Ada");
        expect(primary.textContent?.trim()).toBe("A");
        expect(stack.getAttribute("aria-label")).toBe(
          ownerCount === 2 ? "Owned by Ada · with Bob" : `Owned by Ada · +${ownerCount - 1} more`,
        );
        expect(row.matches(":hover")).toBe(state === "hover");
        if (
          theme === "claw" &&
          presence === "present" &&
          ownerCount <= 3 &&
          (state === "idle" || state === "selected")
        ) {
          await expect
            .poll(() => cutouts(stack, row))
            .toEqual([0, 1].map(() => ({ width: "1px", matchesRow: true })));
        }
        const peerBounds = peer.getBoundingClientRect();
        const stackBounds = stack.getBoundingClientRect();
        expect(stackBounds.width).toBeGreaterThan(primary.getBoundingClientRect().width);
        const leftToRight = ownerCount === 2 ? [peer, primary] : [primary, peer];
        for (const [index, face] of leftToRight.entries()) {
          expect(face.getBoundingClientRect()).toMatchObject({
            width: 18,
            height: 18,
            top: stackBounds.top + 1,
            left: stackBounds.left + index * (stackBounds.width - 18),
          });
        }
        expect(getComputedStyle(primary).fontSize).toBe(getComputedStyle(peer).fontSize);
        expect(dimensions(primary.querySelector(".viewer-avatar > span")!)).toEqual([16, 16]);
        const primaryStyle = appearance(primary),
          peerStyle = appearance(peer);
        const opacity = presence === "away" ? "0.45" : "1";
        expect([primaryStyle.opacity, peerStyle.opacity]).toEqual([
          opacity,
          ownerCount > 2 ? opacity : "1",
        ]);
        if (ownerCount > 2) {
          expect(peerStyle.filter).toBe(primaryStyle.filter);
        }
        if (presence === "running") {
          const traceBounds = row.querySelector(".session-glyph__trace")!.getBoundingClientRect();
          expect(traceBounds.left).toBeLessThan(stackBounds.left);
          expect(traceBounds.right).toBeGreaterThan(stackBounds.right);
          expect(traceBounds.left + traceBounds.width / 2).toBeCloseTo(
            stackBounds.left + stackBounds.width / 2,
            3,
          );
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
          expect(dimensions(peer.querySelector("span")!)).toEqual([16, 16]);
          continue;
        }
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
        if (presence === "away") {
          continue;
        }
        const rowLuminance = renderedLuminance(
          getComputedStyle(sidebar).backgroundColor,
          getComputedStyle(row, "::after").backgroundColor,
        );
        const counterLuminance = paintedCounterLuminance(peer, capture!);
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
      const { row, primary, peer, setOwnerViewing } = rows[0]!;
      if (theme === "claw" && presence === "away" && ownerCount === 3) {
        setOwnerViewing(true);
        flush();
        await expect
          .poll(() => [primary, peer].map(appearance))
          .toEqual([0, 1].map(() => ({ opacity: "1", filter: "none" })));
      }
      if (presence === "present") {
        row.style.zoom = "4";
        await expectCenteredInk(ownerCount === 2 ? primary : peer);
      }
    },
  );

  it.each(
    modes.flatMap((mode) =>
      (["row", "header"] as const).flatMap((size) =>
        [false, true].map((profile) => ({ mode, size, profile })),
      ),
    ),
  )(
    "centers a single $size initial in $mode with profile=$profile",
    async ({ mode, size, profile }) => {
      await applyTheme("claw", mode);
      const view = mountSolid(() => (
        <SessionOwnerChip
          owner={profile ? { ...ada, identity } : ada}
          participants={participants}
          participantCount={0}
          size={size}
        />
      ));
      const chip = view.container.querySelector<HTMLElement>("openclaw-session-owner-chip")!;
      await readyAvatars(chip);
      const owner = chip.querySelector<HTMLElement>(".session-owner-chip")!;
      if (size === "row") {
        expect(owner.getBoundingClientRect()).toMatchObject({ width: 20, height: 20 });
        expect(chip.querySelector(".session-owner-stack")).toBeNull();
      }
      chip.style.zoom = "4";
      await expectCenteredInk(owner);
      if (size === "row") {
        const { row } = sidebarFixture(false);
        row.append(chip);
        expect(getComputedStyle(owner)).toMatchObject({ borderTopWidth: "0px", boxShadow: "none" });
      }
    },
  );
});
