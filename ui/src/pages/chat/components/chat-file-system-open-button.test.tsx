/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../../src/shared/deferred.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import * as toast from "../../../lib/toast.ts";
import { restoreMocksAndGlobals } from "../../../test-helpers/mock-cleanup.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { FileSystemOpenButton } from "./chat-file-system-open-button.tsx";

registerFilePreviewEnglish();
afterEach(() => restoreMocksAndGlobals());

it("deduplicates a pending opener and shows a failure that can be retried", async () => {
  const pending = createDeferredCore();
  const open = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
  const report = vi.spyOn(toast, "showToast").mockReturnValue(true);
  const view = mountSolid(() => <FileSystemOpenButton open={open} />);
  const button = view.getByRole("button");
  button.click();
  button.click();
  expect(open).toHaveBeenCalledOnce();
  await waitForSolid(() => expect(button.hasAttribute("disabled")).toBe(true));
  pending.reject(new Error("No desktop handler"));
  await waitForSolid(() => expect(button.hasAttribute("disabled")).toBe(false));
  expect(report).toHaveBeenCalledWith({ message: expect.stringContaining("No desktop handler") });
  button.click();
  await waitForSolid(() => expect(open).toHaveBeenCalledTimes(2));
});
