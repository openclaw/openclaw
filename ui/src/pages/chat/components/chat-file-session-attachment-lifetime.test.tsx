/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { SessionFileDownload } from "../../../api/session-file-download.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createComposerProps, resetComposerFixture } from "../chat-composer.test-support.ts";
import { createChatSidebarContainer } from "./chat-sidebar.test-support.ts";
import "./chat-detail-panel.tsx";

afterEach(async () => {
  document.body.replaceChildren();
  await resetComposerFixture();
  vi.unstubAllGlobals();
});

async function startHeldTransfer() {
  const held = Promise.withResolvers<SessionFileDownload | null>();
  const fetcher = vi.fn(async () => new Response("Synthetic file bytes"));
  vi.stubGlobal("fetch", fetcher);
  const attachments: ChatAttachment[] = [];
  const observation: { balance: number; signal?: AbortSignal } = { balance: 0 };
  const chat = createComposerProps({
    getAttachments: () => attachments,
    onAttachmentsChange: (next) => {
      attachments.splice(0, attachments.length, ...next);
    },
    onPendingReadsChange: (delta) => {
      observation.balance += delta;
    },
  });
  const panel = document.createElement("openclaw-chat-detail-panel");
  panel.attachmentRuntime = { connectionEpoch: 1 };
  panel.attachmentChat = chat;
  panel.content = {
    kind: "markdown",
    content: "Synthetic file preview",
    fileDownload: {
      path: "notes.md",
      name: "notes.md",
      download: (nextSignal) => {
        observation.signal = nextSignal;
        return held.promise;
      },
    },
  };
  const container = createChatSidebarContainer();
  container.append(panel);
  document.body.append(container);
  await panel.updateComplete;
  await waitForSolid(() =>
    expect(panel.querySelector('[aria-label="More file actions"]')).not.toBeNull(),
  );
  panel.querySelector<HTMLButtonElement>('[aria-label="More file actions"]')!.click();
  const attach = await waitForSolid(() => {
    const action = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.includes("Attach to session"),
    );
    expect(action).toBeDefined();
    return action!;
  });
  attach.click();
  expect(observation.balance).toBe(1);
  const finish = () =>
    held.resolve({
      filename: "notes.md",
      url: "/api/artifacts/download/synthetic-notes/synthetic-ticket",
    });
  return { held, finish, fetcher, attachments, chat, panel, container, observation };
}

it.each(["content", "destination", "reparent"] as const)(
  "settles a held native transfer after %s changes",
  async (change) => {
    const { held, finish, fetcher, attachments, chat, panel, container, observation } =
      await startHeldTransfer();
    const retained = change === "reparent";
    if (change === "content") {
      panel.content = { kind: "markdown", content: "Replacement preview" };
    } else if (change === "destination") {
      panel.attachmentChat = { ...chat, sessionKey: "agent:main:replacement" };
    } else {
      container.appendChild(document.createElement("section")).append(panel);
      await panel.updateComplete;
    }
    expect(observation).toMatchObject({
      signal: { aborted: !retained },
      balance: retained ? 1 : 0,
    });
    await panel.updateComplete;
    finish();
    await held.promise;
    await Promise.resolve();
    await waitForSolid(() => {
      expect(attachments).toHaveLength(retained ? 1 : 0);
      expect(observation.balance).toBe(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(retained ? 1 : 0);
  },
);
