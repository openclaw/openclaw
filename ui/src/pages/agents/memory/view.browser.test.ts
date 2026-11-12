import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import "../../../styles.css";
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
  it("keeps the page's width at phone size with many diary dates and a long entry", async () => {
    host = document.createElement("div");
    host.style.width = "358px";
    document.body.append(host);

    const viewState = createDreamingViewState();
    const props: Parameters<typeof renderDreaming>[0] = createDreamingViewProps(viewState, {
      access: { ...fullDreamingViewAccess },
      dreamDiaryContent: [
        "# Dream Diary",
        ...Array.from(
          { length: 30 },
          (_, index) =>
            `---\n\n*October ${index + 1}, 2026, 3:00 AM*\n\n${"A long dream that keeps going ".repeat(20)}`,
        ),
      ].join("\n\n"),
      memoryWikiEnabled: false,
      onViewStateChange: (update) => {
        update(viewState);
        renderDreamingView(props, host!);
      },
    });
    renderDreamingView(props, host);

    const page = expectDefined(host.querySelector<HTMLElement>(".dreams-page"), "dreams page");
    expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
    const dates = expectDefined(
      host.querySelector<HTMLElement>(".dreams-diary__dates"),
      "diary dates",
    );
    expect(dates.getBoundingClientRect().right).toBeLessThanOrEqual(
      host.getBoundingClientRect().right,
    );
  });

  it("smooths diary prose for reading while dates and page chrome stay antialiased", () => {
    host = document.createElement("div");
    document.body.append(host);
    const props = createDreamingViewProps(createDreamingViewState(), {
      dreamDiaryContent: "# Dream Diary\n\n---\n\n*October 1, 2026, 3:00 AM*\n\nA quiet dream.",
    });
    renderDreamingView(props, host);

    const smoothing = (selector: string) =>
      getComputedStyle(expectDefined(document.querySelector(selector), selector)).getPropertyValue(
        "-webkit-font-smoothing",
      );
    expect(smoothing(".dreams-diary__para")).toBe("auto");
    expect(smoothing(".dreams-diary__date")).toBe("antialiased");
    expect(smoothing("body")).toBe("antialiased");
  });
});
