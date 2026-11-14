import { expect } from "vitest";
import "../lib/toast-host.tsx";
import { waitForFast } from "./wait-for.ts";

/**
 * Closes the held archive's Undo toast through its dismiss control, which ends the
 * window and sends the archive. Mounts a toast host when the test has none.
 */
export async function closeArchiveUndoToast(): Promise<void> {
  let host = document.querySelector("openclaw-toast-host");
  const mounted = !host;
  if (!host) {
    host = document.createElement("openclaw-toast-host");
    document.body.append(host);
  }
  const findUndo = () =>
    [...host.querySelectorAll(".app-toast")].find(
      (toast) => toast.querySelector(".app-toast__action")?.textContent?.trim() === "Undo",
    );
  await waitForFast(() => expect(findUndo()).toBeDefined());
  findUndo()!.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
  await waitForFast(() => expect(findUndo()).toBeUndefined());
  if (mounted) {
    host.remove();
  }
}
