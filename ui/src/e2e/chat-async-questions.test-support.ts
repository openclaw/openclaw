import type { Page } from "playwright";
import type { DurableQuestionDraft } from "../lib/chat/composer-draft-store.runtime.ts";

export async function readStoredQuestionDrafts(page: Page): Promise<DurableQuestionDraft[]> {
  return page.evaluate(async () => {
    if (!(await indexedDB.databases()).some((db) => db.name === "openclaw-control-ui")) {
      return [];
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("openclaw-control-ui");
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener(
        "error",
        () => reject(request.error ?? new Error("Could not open question draft database")),
        { once: true },
      );
    });
    try {
      const records = await new Promise<Array<{ questionDrafts?: DurableQuestionDraft[] }>>(
        (resolve, reject) => {
          const request = db
            .transaction("composerDrafts", "readonly")
            .objectStore("composerDrafts")
            .getAll();
          request.addEventListener("success", () => resolve(request.result), { once: true });
          request.addEventListener(
            "error",
            () => reject(request.error ?? new Error("Could not read question drafts")),
            { once: true },
          );
        },
      );
      return records.flatMap((record) => record.questionDrafts ?? []);
    } finally {
      db.close();
    }
  });
}
