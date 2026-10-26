import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { createDreamingViewState } from "./dreaming.ts";
import {
  createDreamingViewProps,
  fullDreamingViewAccess,
  renderDreamingView,
} from "./view.test-helpers.ts";
import { renderDreaming } from "./view.tsx";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");
let host: HTMLDivElement | undefined;

afterEach(() => {
  cleanupSolid();
  host?.remove();
  host = undefined;
});

describe.skipIf(!hasBrowserLayout)("dream diary browser layout", () => {
  it("keeps diary dates visible and clickable while a long entry scrolls", async () => {
    host = document.createElement("div");
    host.style.height = "420px";
    host.style.width = "760px";
    host.style.overflow = "hidden";
    document.body.append(host);

    const viewState = createDreamingViewState();
    viewState.activeSubTab = "diary";
    viewState.activeDiarySubTab = "dreams";
    const props: Parameters<typeof renderDreaming>[0] = createDreamingViewProps(viewState, {
      access: { ...fullDreamingViewAccess },
      dreamDiaryContent: [
        "# Dream Diary",
        "---",
        "*January 1, 2026*",
        "The earlier diary entry remains available.",
        "---",
        "*January 2, 2026*",
        ...Array.from(
          { length: 24 },
          (_, index) => `Long diary paragraph ${index + 1}: ${"a visible memory ".repeat(8)}`,
        ),
      ].join("\n\n"),
      memoryWikiEnabled: false,
      onViewStateChange: (update) => {
        update(viewState);
        renderDreamingView(props, host!);
      },
    });
    renderDreamingView(props, host);

    const diary = host.querySelector<HTMLElement>(".dreams-diary");
    const navigation = host.querySelector<HTMLElement>(".dreams-diary__daychips");
    expect(diary).not.toBeNull();
    expect(navigation).not.toBeNull();
    expect(getComputedStyle(diary!).overflowY).toBe("auto");
    expect(getComputedStyle(navigation!.parentElement!).position).toBe("sticky");
    expect(diary!.scrollHeight).toBeGreaterThan(diary!.clientHeight);

    diary!.scrollTop = 500;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    const olderDate = expectDefined(
      navigation!.querySelectorAll<HTMLButtonElement>(".dreams-diary__day-chip")[1],
      "older diary date button",
    );
    expect(diary!.scrollTop).toBeGreaterThan(100);
    expect(olderDate.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      diary!.getBoundingClientRect().top,
    );
    expect(olderDate.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      diary!.getBoundingClientRect().bottom,
    );

    olderDate.click();
    expect(viewState.diaryPage).toBe(1);
    expect(host.querySelector(".dreams-diary__date")?.textContent).toBe("January 1, 2026");
  });
});
