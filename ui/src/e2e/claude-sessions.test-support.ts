import type { Locator } from "playwright";
import { expect } from "vitest";

export async function expectTranscriptLayoutCommitted(thread: Locator) {
  // Wait for ResizeObserver's inline size/padding writes, not CSS that can fill the slot early.
  await expect
    .poll(() =>
      thread.evaluate((element) => {
        const slot = element.parentElement;
        if (!(element instanceof HTMLElement) || !slot) {
          return false;
        }
        const slotBox = slot.getBoundingClientRect();
        const slotStyle = getComputedStyle(slot);
        return (
          slotBox.width > 0 &&
          slotBox.height > 0 &&
          Number.parseFloat(element.style.width) === slotBox.width &&
          Number.parseFloat(element.style.height) === slotBox.height &&
          element.style.paddingTop === slotStyle.paddingTop &&
          element.style.paddingBottom === slotStyle.paddingBottom &&
          element.getBoundingClientRect().width === slotBox.width
        );
      }),
    )
    .toBe(true);
}

function nativeCatalog<T>(id: string, label: string, hosts: T[]) {
  return { id, label, capabilities: { continueSession: true, archive: false }, hosts };
}
function storedSession(threadId: string, name: string, canContinue = true) {
  return { threadId, name, status: "stored", canContinue, canArchive: false };
}

export function resumableClaudeCatalog() {
  const session = {
    ...storedSession("claude-terminal-session", "Native Claude terminal"),
    source: "claude-cli",
    archived: false,
    canOpenTerminal: true,
  };
  const host = {
    hostId: "gateway:local",
    label: "Local Mac",
    kind: "local",
    connected: true,
    sessions: [session],
  };
  return { catalogs: [nativeCatalog("claude", "Claude Code", [host])] };
}

export function hostGroupedNativeCatalogs() {
  const catalog = (id: "claude" | "codex", label: string) =>
    nativeCatalog(
      id,
      label,
      [true, false].map((local) => {
        const host = {
          hostId: local ? "gateway:local" : "node:build",
          label: local ? "Gateway Mac" : "Build Node",
          kind: local ? "gateway" : "node",
          connected: true,
          sessions: [
            storedSession(
              `${id}-${local ? "local" : "remote"}`,
              `${label} ${local ? "local plan" : "remote review"}`,
              local,
            ),
          ],
        };
        return local ? host : Object.assign(host, { nodeId: "build" });
      }),
    );
  return { catalogs: [catalog("claude", "Claude Code"), catalog("codex", "Codex")] };
}
