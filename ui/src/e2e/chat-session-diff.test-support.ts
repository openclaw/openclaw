import type { Page } from "playwright";
import type {
  SessionDiffFile,
  SessionsDiffResult,
} from "../../../packages/gateway-protocol/src/index.js";

export function diffResponse(
  files: SessionDiffFile[],
  metadata: Partial<Omit<SessionsDiffResult, "files" | "additions" | "deletions">> = {},
): SessionsDiffResult {
  return {
    sessionKey: "main",
    ...metadata,
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

export async function setDiffView(page: Page, view: "Split" | "Unified") {
  await page.locator(".session-diff").getByRole("button", { name: "Change view options" }).click();
  await page.getByRole("menuitem", { name: `Switch to ${view} Diff` }).click();
}

export function singleFileDiff(
  path: string,
  patch: string,
  additions: number,
  deletions: number,
  metadata: Parameters<typeof diffResponse>[1] = {},
) {
  return diffResponse([{ path, patch, status: "modified", additions, deletions }], metadata);
}

export const nextPaint = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
