import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { isComposerDraftCommitted, waitForCommittedState } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI committed-state waits" });

suite.define(() => {
  it("rejects an older annotation with the same draft text, attachment count, and filename", async () => {
    await suite.withPage({}, async ({ page }) => {
      await page.route("**/committed-draft-fixture", (route) =>
        route.fulfill({ contentType: "text/html", body: "<openclaw-app></openclaw-app>" }),
      );
      await page.goto(`${suite.server.baseUrl}committed-draft-fixture`);
      const finalComment = "Explain the rollback checks. 🦞";
      const expected = {
        scopeKey: "chat:v3:agent:main:main\u0000agent:main",
        text: "Please explain the next step.",
        attachmentCount: 1,
        attachmentNames: JSON.stringify(["selection-comment.txt"]),
        annotationComments: JSON.stringify([finalComment]),
      };
      const context = {
        gateway: {
          connection: { gatewayUrl: "ws://synthetic-gateway" },
          snapshot: { client: { recoveryScope: "synthetic-credential" } },
        },
      };
      const commit = (comment: string) =>
        page.evaluate(
          async ({ key, draft }) => {
            const database = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open("openclaw-control-ui");
              request.addEventListener(
                "upgradeneeded",
                () => request.result.createObjectStore("composerDrafts"),
                { once: true },
              );
              request.addEventListener("success", () => resolve(request.result), { once: true });
              const fail = () => reject(request.error ?? new Error("IndexedDB open failed"));
              request.addEventListener("error", fail, { once: true });
            });
            try {
              await new Promise<void>((resolve, reject) => {
                const transaction = database.transaction("composerDrafts", "readwrite");
                transaction.objectStore("composerDrafts").put(draft, key);
                transaction.addEventListener("complete", () => resolve(), { once: true });
                const fail = () =>
                  reject(transaction.error ?? new Error("IndexedDB write failed or aborted"));
                transaction.addEventListener("abort", fail, { once: true });
                transaction.addEventListener("error", fail, { once: true });
              });
            } finally {
              database.close();
            }
          },
          {
            key: JSON.stringify([
              "ws://synthetic-gateway",
              "synthetic-credential",
              expected.scopeKey,
            ]),
            draft: {
              revision: 1,
              text: expected.text,
              attachments: [
                { fileName: "selection-comment.txt", selectionAnnotation: { comment } },
              ],
            },
          },
        );

      await commit(`${finalComment}\nKeep the existing draft.`);
      const committed = (annotationComments: string | null = expected.annotationComments) =>
        page.evaluate(isComposerDraftCommitted, {
          context,
          expected: { ...expected, annotationComments },
        });
      expect(await committed(null)).toBe(true);
      expect(await committed()).toBe(false);
      await commit(finalComment);
      expect(await committed()).toBe(true);
    });
  });

  it("retries async false results until commitment survives a render boundary", async () => {
    await suite.withPage({}, async ({ page }) => {
      await page.setContent('<body data-probes="0" data-committed="false"></body>');
      await waitForCommittedState(
        page,
        async () => {
          await Promise.resolve();
          const state = document.body.dataset;
          const probes = Number(state.probes) + 1;
          state.probes = String(probes);
          if (probes < 3) {
            return false;
          }
          state.committed = "true";
          requestAnimationFrame(() => {
            state.rendered = "true";
          });
          return true;
        },
        {},
      );

      expect(await page.locator("body").evaluate((body) => ({ ...body.dataset }))).toMatchObject({
        committed: "true",
        rendered: "true",
      });
    });
  });
});
