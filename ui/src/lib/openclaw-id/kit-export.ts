// Ways to keep the recovery kit (OCF-286): a text file, the browser's print
// dialog. Nothing here logs the kit or sends it to a server.
import { reserveExternalWindowForDeferredNavigation } from "../open-external-url.ts";
import type { OpenClawIdKit } from "./link.ts";

/** What the kit page names besides the secret. */
export type RecoveryKitDetails = {
  kit: OpenClawIdKit;
  /** The claw's address, https://<hostname>. */
  hostname: string;
  /** The signed-in OpenClaw ID account, when known. */
  owner: string | null;
  createdAt: Date;
};

/** The kit as plain text lines (also what the printed page shows). */
export function recoveryKitLines(details: RecoveryKitDetails): string[] {
  return [
    "OpenClaw Recovery Kit",
    "",
    `Recovery code: ${details.kit.text}`,
    `Recovery kit ID: ${details.kit.rootFingerprint}`,
    ...(details.owner ? [`Owner: ${details.owner}`] : []),
    `Created: ${details.createdAt.toISOString().slice(0, 10)}`,
    `First claw: https://${details.hostname}`,
    "",
    "Anyone with this kit can control the claws it protects. Never share it or read it to anyone.",
  ];
}

/** Offers the kit as a text file download. */
export function downloadRecoveryKit(details: RecoveryKitDetails): void {
  const blob = new Blob([`${recoveryKitLines(details).join("\n")}\n`], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "openclaw-recovery-kit.txt";
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Opens the kit in a blank window and starts the browser's print dialog
 * (which also offers Save as PDF). Returns false when the window was blocked.
 */
export function printRecoveryKit(details: RecoveryKitDetails): boolean {
  const view = reserveExternalWindowForDeferredNavigation({ popup: true });
  if (!view) {
    return false;
  }
  const doc = view.document;
  doc.title = "OpenClaw Recovery Kit";
  const main = doc.createElement("main");
  main.style.cssText = "font: 14px/1.6 system-ui, sans-serif; padding: 32px; max-width: 560px";
  for (const line of recoveryKitLines(details)) {
    const paragraph = doc.createElement("p");
    paragraph.style.margin = "0 0 6px";
    paragraph.textContent = line || "\u00a0";
    main.append(paragraph);
  }
  doc.body.replaceChildren(main);
  view.focus();
  view.print();
  return true;
}
