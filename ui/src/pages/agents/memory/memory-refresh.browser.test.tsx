import { getByRole } from "@solidjs/testing-library";
import { afterAll, afterEach, expect, it } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createPage, DIARY, emptyReply, STATUS } from "./memory-panel.test-support.ts";
import { installDreamingViewTestTranslations } from "./view.test-helpers.ts";

const restoreTranslations = installDreamingViewTestTranslations();
afterAll(restoreTranslations);
afterEach(cleanupSolid);

it("clears replayed entries while an older status refresh is still pending", async () => {
  const method = "doctor.memory.resetGroundedShortTerm";
  const oldStatus = createDeferred<unknown>();
  const entry = {
    key: "replayed-note",
    path: "memory/2026-10-22.md",
    startLine: 1,
    endLine: 1,
    snippet: "Synthetic replayed memory",
    recallCount: 0,
    dailyCount: 0,
    groundedCount: 1,
    totalSignalCount: 1,
    lightHits: 1,
    remHits: 0,
    phaseHitCount: 1,
  };
  const status = (cleared: boolean) => ({
    dreaming: {
      enabled: true,
      shortTermCount: cleared ? 0 : 1,
      shortTermEntries: cleared ? [] : [entry],
      promotedEntries: [],
    },
  });
  let reads = 0;
  let cleared = false;
  const panel = await createPage(
    (name) => {
      if (name === STATUS) {
        if (++reads === 2) {
          return oldStatus.promise;
        }
        return Promise.resolve(status(cleared));
      }
      if (name === method) {
        cleared = true;
        return Promise.resolve({ removedShortTermEntries: 1 });
      }
      return Promise.resolve(emptyReply(name));
    },
    "main",
    gatewayHelloForMethods([STATUS, DIARY, method], ["operator.read", "operator.write"]),
  );
  panel.query<HTMLButtonElement>("#dreams-tab-advanced")!.click();
  await waitForSolid(() => expect(panel.container.textContent).toContain(entry.snippet));
  getByRole<HTMLButtonElement>(panel.container, "button", { name: /^Refresh$/u }).click();
  await waitForSolid(() => expect(reads).toBe(2));
  const clear = getByRole<HTMLButtonElement>(
    panel.container.querySelector(".dreams-advanced__sections")!,
    "button",
    { name: /^Clear Replayed$/u },
  );
  expect(clear.disabled).toBe(false);
  clear.click();
  await waitForSolid(() =>
    expect(panel.container.textContent).toContain("Cleared 1 replayed short-term entries."),
  );
  oldStatus.resolve(status(false));
  await oldStatus.promise;
  await waitForSolid(() => {
    expect(panel.state.diaryActionBusy()).toBe(false);
    expect(panel.container.textContent).not.toContain(entry.snippet);
    expect(panel.query(".dreams-advanced__section-count")?.textContent).toBe("0");
  });
});
