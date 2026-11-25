import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { isComposerDraftCommitted, waitForCommittedState } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI committed-state waits" });

async function writeDraft({ key, value }: { key: string; value: unknown }) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("openclaw-control-ui");
    const upgrade = () => request.result.createObjectStore("composerDrafts");
    const fail = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.addEventListener("upgradeneeded", upgrade, { once: true });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", fail, { once: true });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("composerDrafts", "readwrite");
      const fail = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
      transaction.objectStore("composerDrafts").put(value, key);
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("abort", fail, { once: true });
      transaction.addEventListener("error", fail, { once: true });
    });
  } finally {
    database.close();
  }
}

suite.define(() => {
  it("rejects stale annotations when other draft fields match", () =>
    suite.withPage({}, async ({ page }) => {
      await page.route("**/committed-draft-fixture", (route) =>
        route.fulfill({ contentType: "text/html", body: "<openclaw-app></openclaw-app>" }),
      );
      await page.goto(`${suite.server.baseUrl}committed-draft-fixture`);
      const finalComment = "Explain the rollback checks. 🦞";
      const gatewayUrl = "ws://synthetic-gateway";
      const recoveryScope = "synthetic-credential";
      const fileName = "selection-comment.txt";
      const expected = {
        scopeKey: "chat:v3:agent:main:main\u0000agent:main",
        text: "Please explain the next step.",
        attachmentCount: 1,
        attachmentNames: JSON.stringify([fileName]),
        annotationComments: JSON.stringify([finalComment]),
      };
      const context = {
        gateway: {
          connection: { gatewayUrl },
          snapshot: { client: { recoveryScope } },
        },
      };
      const commit = (comment: string) =>
        page.evaluate(writeDraft, {
          key: JSON.stringify([gatewayUrl, recoveryScope, expected.scopeKey]),
          value: {
            revision: 1,
            text: expected.text,
            attachments: [{ fileName, selectionAnnotation: { comment } }],
          },
        });

      await commit(`${finalComment}\nKeep the existing draft.`);
      const committed = () => page.evaluate(isComposerDraftCommitted, { context, expected });
      expect(await committed()).toBe(false);
      await commit(finalComment);
      expect(await committed()).toBe(true);
    }));

  it("retries async false results until commitment survives a render boundary", () =>
    suite.withPage({}, async ({ page }) => {
      await page.setContent('<body data-probes="0"></body>');
      await waitForCommittedState(
        page,
        async () => {
          await Promise.resolve();
          const state = document.body.dataset;
          state.probes = String(Number(state.probes) + 1);
          if (Number(state.probes) < 3) {
            return false;
          }
          requestAnimationFrame(() => document.body.setAttribute("data-rendered", "true"));
          return true;
        },
        {},
      );

      expect(await page.locator("body").getAttribute("data-rendered")).toBe("true");
    }));
});
