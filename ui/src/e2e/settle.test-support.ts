import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import { getControlUiContextHandle } from "../test-helpers/control-ui-e2e-context.ts";

type SettledFormControl = { locator: Locator } & ({ value: string } | { checked: boolean });

async function waitForBrowserRenderBoundary(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<number>(requestAnimationFrame));
}

export async function waitForSettledFormControls(
  page: Page,
  controls: readonly SettledFormControl[],
): Promise<void> {
  const expected = controls.map((control) =>
    "value" in control ? control.value : control.checked,
  );
  const readControls = () =>
    Promise.all(
      controls.map((control) =>
        "value" in control ? control.locator.inputValue() : control.locator.isChecked(),
      ),
    );
  await expect.poll(readControls).toEqual(expected);
  await waitForBrowserRenderBoundary(page);
  await expect.poll(readControls).toEqual(expected);
}

type CommittedStateArgs = Record<string, boolean | null | number | string>;

export async function waitForCommittedState<Arg>(
  page: Page,
  probe: Parameters<typeof page.evaluate<boolean, Arg>>[0],
  arg: Arg,
): Promise<void> {
  // Resolve async probes and require a match on both sides of a render boundary.
  const readCommittedState = () => page.evaluate(probe, arg);
  await expect.poll(readCommittedState).toBe(true);
  await waitForBrowserRenderBoundary(page);
  await expect.poll(readCommittedState).toBe(true);
}

type ComposerDraftContext = {
  gateway: {
    connection: { gatewayUrl: string };
    snapshot: { client: { recoveryScope?: string } | null };
  };
};

export async function isComposerDraftCommitted({
  context,
  expected,
}: {
  context: ComposerDraftContext;
  expected: CommittedStateArgs;
}): Promise<boolean> {
  const gateway = context.gateway;
  const recoveryScope = gateway?.snapshot.client?.recoveryScope;
  if (
    !recoveryScope ||
    !(await indexedDB.databases()).some((db) => db.name === "openclaw-control-ui")
  ) {
    return false;
  }
  const gatewayOwner = gateway.connection.gatewayUrl.trim() || "default";
  // Serialized probe: read the durable key independently of the renderer.
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("openclaw-control-ui");
    request.addEventListener("success", () => resolve(request.result), { once: true });
    const fail = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.addEventListener("error", fail, { once: true });
  });
  try {
    type Draft = {
      revision: number;
      text: string;
      replyTarget?: { sourceMessageId?: string };
      attachments: { fileName?: string; selectionAnnotation?: { comment: string } }[];
    };
    const key = JSON.stringify([gatewayOwner, recoveryScope, expected.scopeKey]);
    const draft = await new Promise<Draft | undefined>((resolve, reject) => {
      const transaction = database.transaction("composerDrafts", "readonly");
      const request = transaction.objectStore("composerDrafts").get(key) as IDBRequest<
        Draft | undefined
      >;
      transaction.addEventListener("complete", () => resolve(request.result), { once: true });
      const fail = () => reject(transaction.error ?? new Error("IndexedDB read failed or aborted"));
      transaction.addEventListener("abort", fail, { once: true });
      transaction.addEventListener("error", fail, { once: true });
    });
    return Boolean(
      draft &&
      (expected.replySourceMessageId === undefined ||
        (draft.replyTarget?.sourceMessageId ?? null) === expected.replySourceMessageId) &&
      (expected.text === null
        ? typeof draft.revision === "number" && draft.text === "" && draft.attachments.length === 0
        : draft.text === expected.text &&
          draft.attachments.length === expected.attachmentCount &&
          (expected.attachmentNames === null ||
            JSON.stringify(draft.attachments.map((a) => a.fileName)) ===
              expected.attachmentNames) &&
          (expected.annotationComments === null ||
            JSON.stringify(draft.attachments.map((a) => a.selectionAnnotation?.comment ?? null)) ===
              expected.annotationComments)),
    );
  } finally {
    database.close();
  }
}

export async function waitForCommittedComposerDraft(
  page: Page,
  scopeKey: string,
  text: string | null,
  attachments: number | readonly string[],
  annotationComments?: readonly (string | null)[],
  replySourceMessageId?: string | null,
): Promise<void> {
  const context = await getControlUiContextHandle(page);
  try {
    await waitForCommittedState(page, isComposerDraftCommitted, {
      context,
      expected: {
        scopeKey,
        text,
        attachmentCount: typeof attachments === "number" ? attachments : attachments.length,
        attachmentNames: typeof attachments === "number" ? null : JSON.stringify(attachments),
        annotationComments: annotationComments ? JSON.stringify(annotationComments) : null,
        ...(replySourceMessageId !== undefined ? { replySourceMessageId } : {}),
      },
    });
  } finally {
    await context.dispose();
  }
}
