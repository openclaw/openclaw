import type { Page } from "playwright";

type LegacyDraft = {
  gatewayOwner: string;
  scopeKey: string;
  text: string;
  writeId: string;
  revision?: number;
  attachment: { content: string; fileName: string; sizeBytes?: number };
};

// Seed the old physical schema before app boot; the tests exercise its upgrade through the UI.
export async function seedLegacyComposerDraft(page: Page, draft: LegacyDraft): Promise<number> {
  return page.evaluate(async ({ attachment, revision, ...fields }) => {
    const request = indexedDB.open("openclaw-control-ui", 1);
    request.onupgradeneeded = () => {
      request.result
        .createObjectStore("composerDrafts", { keyPath: "key" })
        .createIndex("ownerKey", "ownerKey", { unique: false });
    };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("IndexedDB open failed")),
      );
    });
    try {
      const recoveryScope = "e2e-recovery-scope";
      const { content, ...metadata } = attachment;
      const mimeType = "text/plain";
      const transaction = database.transaction("composerDrafts", "readwrite");
      transaction.objectStore("composerDrafts").put({
        ...fields,
        recoveryScope,
        key: JSON.stringify([fields.gatewayOwner, recoveryScope, fields.scopeKey]),
        ownerKey: JSON.stringify([fields.gatewayOwner, recoveryScope]),
        revision: revision ?? Date.now(),
        updatedAt: Date.now(),
        attachments: [{ ...metadata, mimeType, blob: new Blob([content], { type: mimeType }) }],
      });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        const failed = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
        transaction.addEventListener("abort", failed);
        transaction.addEventListener("error", failed);
      });
      return database.version;
    } finally {
      database.close();
    }
  }, draft);
}
