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

export const asyncQuestionTitle = "Which audience should the summary address?";
export const sharedQuestion = {
  role: "assistant",
  __openclaw: { id: "audience-prompt", seq: 1 },
  content: asyncQuestionTitle + "\n\n1. Engineers\n2. Everyone",
  timestamp: 1_789_000_000_000,
  openclawAsyncDelivery: {
    itemId: "audience-question",
    questions: [{ title: asyncQuestionTitle, options: ["Engineers", "Everyone"] }],
  },
};

export function acceptedQuestionInput(runId: string, answer = "Engineers", legacy = false) {
  return {
    id: "shared-answer",
    runId,
    state: "queued",
    queued: true,
    acceptedAt: Date.now(),
    message: {
      role: "user",
      content: "> " + asyncQuestionTitle + "\n\n" + answer,
      __openclaw: {
        replyToId: "audience-prompt",
        ...(!legacy && { asyncQuestionItemId: "audience-question" }),
      },
    },
  };
}

export function sharedQuestionHistory(input: ReturnType<typeof acceptedQuestionInput>) {
  return {
    sessionId: "session:agent:main:main",
    messages: [sharedQuestion],
    sessionInfo: {
      key: "agent:main:main",
      sessionId: "session:agent:main:main",
      status: "done",
      hasActiveRun: false,
    },
    pendingInputs: { items: [input], total: 1, queuedCount: 1 },
    inputReceipts: [{ runId: input.runId, state: "pending", queued: true }],
  };
}
