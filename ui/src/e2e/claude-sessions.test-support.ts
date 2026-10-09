import type { Locator } from "playwright";
import { expect } from "vitest";

export async function expectTranscriptLayoutCommitted(thread: Locator) {
  // CSS can fill the slot before ResizeObserver commits. Wait for the
  // layout owner's inline size and padding writes, not computed centering.
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

export function resumableClaudeCatalog() {
  return {
    catalogs: [
      {
        id: "claude",
        label: "Claude Code",
        capabilities: { continueSession: true, archive: false },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Mac",
            kind: "local",
            connected: true,
            sessions: [
              {
                threadId: "claude-terminal-session",
                name: "Native Claude terminal",
                status: "stored",
                source: "claude-cli",
                archived: false,
                canContinue: true,
                canArchive: false,
                canOpenTerminal: true,
              },
            ],
          },
        ],
      },
    ],
  };
}

export function hostGroupedNativeCatalogs() {
  const catalog = (id: "claude" | "codex", label: string) => ({
    id,
    label,
    capabilities: { continueSession: true, archive: false },
    hosts: [
      {
        hostId: "gateway:local",
        label: "Gateway Mac",
        kind: "gateway",
        connected: true,
        sessions: [
          {
            threadId: `${id}-local`,
            name: `${label} local plan`,
            status: "stored",
            canContinue: true,
            canArchive: false,
          },
        ],
      },
      {
        hostId: "node:build",
        label: "Build Node",
        kind: "node",
        connected: true,
        nodeId: "build",
        sessions: [
          {
            threadId: `${id}-remote`,
            name: `${label} remote review`,
            status: "stored",
            canContinue: false,
            canArchive: false,
          },
        ],
      },
    ],
  });
  return { catalogs: [catalog("claude", "Claude Code"), catalog("codex", "Codex")] };
}
