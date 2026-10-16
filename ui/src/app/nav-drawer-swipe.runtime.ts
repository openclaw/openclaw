import { isMobileNavLayout } from "./mobile-nav-layout.ts";

const MIN_OPEN_DISTANCE_PX = 44;
const OPEN_RATIO = 0.15;
const LOCK_DISTANCE_PX = 7;
const DIRECTION_RATIO = 1.25;

type Swipe = {
  identifier: number;
  startX: number;
  startY: number;
  lockedHorizontal: boolean;
};

export type NavDrawerHost = Pick<HTMLElement, "querySelector" | "isConnected"> & {
  readonly element: HTMLElement;
  readonly onboardingMode: boolean;
  readonly navDrawerOpen: boolean;
};

export class NavDrawerSwipeOwner {
  private swipe: Swipe | null = null;

  constructor(
    private readonly host: NavDrawerHost,
    private readonly requestOpen: () => void,
  ) {}

  private canOpen(): boolean {
    return (
      isMobileNavLayout() &&
      !this.host.navDrawerOpen &&
      !this.host.onboardingMode &&
      !document.openClawModalLayers?.size
    );
  }

  connect(): void {
    this.host.element.addEventListener("touchstart", this.handleStart, { passive: true });
    this.host.element.addEventListener("touchmove", this.handleMove, { passive: false });
    this.host.element.addEventListener("touchend", this.handleEnd, { passive: true });
    this.host.element.addEventListener("touchcancel", this.cancel, { passive: true });
  }

  disconnect(): void {
    this.host.element.removeEventListener("touchstart", this.handleStart);
    this.host.element.removeEventListener("touchmove", this.handleMove);
    this.host.element.removeEventListener("touchend", this.handleEnd);
    this.host.element.removeEventListener("touchcancel", this.cancel);
    this.reset();
  }

  reset(): void {
    this.swipe = null;
  }

  private openAfterSwipe(deltaX: number): void {
    const width =
      this.host.querySelector<HTMLElement>(".shell-nav")?.getBoundingClientRect().width ?? 0;
    if (deltaX >= Math.max(MIN_OPEN_DISTANCE_PX, width * OPEN_RATIO)) {
      // Commit once intent is clear; a held gesture must not leave clipped
      // navigation text and a non-interactive scrim sitting over the chat.
      this.reset();
      this.requestOpen();
    }
  }

  private readonly cancel = (): void => this.reset();

  private readonly handleStart = (event: TouchEvent): void => {
    this.reset();
    if (!this.canOpen() || event.touches.length !== 1) {
      return;
    }
    const path = event.composedPath();
    const content = path.find(
      (target): target is HTMLElement =>
        target instanceof HTMLElement && target.classList.contains("content"),
    );
    if (!content) {
      return;
    }
    const blocked = path.slice(0, path.indexOf(content)).some((target) => {
      if (!(target instanceof Element)) {
        return false;
      }
      if (
        target.matches(
          "a, button, input, textarea, select, pre, [role='slider'], [contenteditable]:not([contenteditable='false'])",
        )
      ) {
        return true;
      }
      return target instanceof HTMLElement && target.scrollWidth > target.clientWidth + 1;
    });
    const touch = event.touches[0];
    if (blocked || !touch) {
      return;
    }
    this.swipe = {
      identifier: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      lockedHorizontal: false,
    };
  };

  private readonly handleMove = (event: TouchEvent): void => {
    const swipe = this.swipe;
    const touch = swipe
      ? Array.from(event.touches).find((candidate) => candidate.identifier === swipe.identifier)
      : undefined;
    if (!this.canOpen() || !swipe || event.touches.length !== 1 || !touch) {
      this.cancel();
      return;
    }
    const deltaX = touch.clientX - swipe.startX;
    const deltaY = touch.clientY - swipe.startY;
    if (swipe.lockedHorizontal) {
      event.preventDefault();
      this.openAfterSwipe(deltaX);
      return;
    }
    const distanceX = Math.abs(deltaX);
    const distanceY = Math.abs(deltaY);
    if (Math.max(distanceX, distanceY) < LOCK_DISTANCE_PX) {
      return;
    }
    if (deltaX > 0 && distanceX >= distanceY * DIRECTION_RATIO) {
      swipe.lockedHorizontal = true;
      event.preventDefault();
      this.openAfterSwipe(deltaX);
    } else if (deltaX <= -LOCK_DISTANCE_PX || distanceY >= distanceX * DIRECTION_RATIO) {
      this.reset();
    }
  };

  private readonly handleEnd = (event: TouchEvent): void => {
    const swipe = this.swipe;
    const touch = swipe
      ? Array.from(event.changedTouches).find(
          (candidate) => candidate.identifier === swipe.identifier,
        )
      : undefined;
    if (!swipe || !touch || !swipe.lockedHorizontal || !this.canOpen()) {
      this.reset();
      return;
    }
    const deltaX = touch.clientX - swipe.startX;
    this.openAfterSwipe(deltaX);
    this.reset();
  };
}
