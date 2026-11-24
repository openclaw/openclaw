// @vitest-environment jsdom
import { expect, it, onTestFinished } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { ProgressCardMarkdown } from "./session-progress-card-view.tsx";

it("omits progress bars and their emptied paragraphs on request", () => {
  onTestFinished(cleanupSolid);
  const view = mountSolid(() => (
    <ProgressCardMarkdown
      markdown={'Building.\n\n<progress value="3" max="7"></progress>\n\nWaiting.'}
      omitProgress
    />
  ));
  flush();
  const markdown = view.container.querySelector(".session-progress-card__markdown");
  expect(markdown?.querySelector("progress")).toBeNull();
  expect(markdown?.textContent).toContain("Building.");
  expect(markdown?.textContent).toContain("Waiting.");
  expect(markdown?.querySelectorAll("p")).toHaveLength(2);
});
