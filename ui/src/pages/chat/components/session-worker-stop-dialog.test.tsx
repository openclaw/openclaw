/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.ts";
import {
  installDialogPolyfill,
  waitForRenderedModalDialog,
} from "../../../test-helpers/modal-dialog.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { showSessionWorkerStopDialog } from "./session-worker-stop-dialog.tsx";

it("blocks duplicate confirmation and dismissal until a worker stop settles, then allows retry", async () => {
  const restore = installDialogPolyfill();
  const response = createDeferred<"close" | "retry">();
  const confirm = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValue("close");
  const completion = showSessionWorkerStopDialog({
    description: "Stop the synthetic worker.",
    confirm,
  });
  let modal: HTMLElement | undefined;
  try {
    ({ modal } = await waitForRenderedModalDialog(document.body));
    const submit = modal.querySelector<HTMLButtonElement>(".session-worker-stop__submit")!;
    submit.click();
    submit.click();
    const cancel = new CustomEvent("modal-cancel", { cancelable: true });
    modal.dispatchEvent(cancel);

    expect(cancel.defaultPrevented).toBe(true);
    await waitForSolid(() => expect(confirm).toHaveBeenCalledOnce());
    flush();
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute("aria-busy")).toBe("true");

    response.resolve("retry");
    await response.promise;
    await waitForSolid(() => expect(submit.disabled).toBe(false));
    expect(document.body.contains(modal)).toBe(true);
    expect(submit.getAttribute("aria-busy")).toBe("false");
    submit.click();
    await completion;

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(document.body.contains(modal)).toBe(false);
  } finally {
    response.resolve("close");
    await Promise.resolve();
    flush();
    modal?.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
    await completion;
    restore();
  }
});
