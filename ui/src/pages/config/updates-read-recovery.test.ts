/* @vitest-environment jsdom */
import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createUpdateRunFixture } from "../../test-helpers/update-run.ts";
import {
  createUpdatesViewDom,
  createUpdatesViewProps as createProps,
} from "./updates.test-support.ts";
import { renderUpdates } from "./updates.ts";

let container: HTMLDivElement;
let row: ReturnType<typeof createUpdatesViewDom>["row"];

beforeEach(async () => {
  await i18n.setLocale("en");
  ({ container, row } = createUpdatesViewDom());
});

describe("update status read recovery", () => {
  it.each([true, false])(
    "keeps read-only recovery after a refused update with canCheckStatus=%s",
    (canCheckStatus) => {
      const onCheckStatus = vi.fn(async () => true);
      const onUpdateNow = vi.fn();
      render(
        renderUpdates(
          createProps({
            update: {
              updateRun: createUpdateRunFixture({
                status: "skipped",
                phase: "finished",
                reason: "external-supervisor-update-required",
                steps: [],
              }),
              updateStatusBanner: {
                source: "read",
                tone: "danger",
                text: "update.runs.get timed out",
              },
              updateStatusCheckBanner: null,
            },
            canCheckStatus,
            onCheckStatus,
            onUpdateNow,
          }),
        ),
        container,
      );

      expect(row("Status").textContent).toContain("update.runs.get timed out");
      const check = row("Recovery").querySelector<HTMLButtonElement>("button")!;
      expect(check.textContent?.trim()).toBe("Check status");
      expect(check.disabled).toBe(!canCheckStatus);
      check.click();
      expect(onCheckStatus).toHaveBeenCalledTimes(canCheckStatus ? 1 : 0);
      expect(onUpdateNow).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Retry update");
      expect(container.textContent).not.toContain("CLI fallback");
      expect(container.textContent).not.toContain("openclaw triage");
    },
  );
});
