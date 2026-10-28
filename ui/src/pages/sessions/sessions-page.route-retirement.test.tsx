/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { i18n } from "../../i18n/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { openSubmenu, selectMenuValue } from "../../test-helpers/session-menu.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { mountSessionsRoute } from "./sessions-route.test-support.tsx";

it("keeps hub labels live and navigates only after activating another tab", async () => {
  const { context, container, dispose } = await mountSessionsRoute(() => sessionsResult([]));
  const navigate = vi.spyOn(context, "navigate").mockImplementation(() => {});
  const locale = i18n.getLocale();
  try {
    document.body.append(container);
    const selected = container.querySelector<HTMLButtonElement>("#sessions-tab-sessions")!;
    const worktrees = container.querySelector<HTMLButtonElement>("#sessions-tab-worktrees")!;
    selected.click();
    selected.focus();
    selected.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(worktrees);
    expect(navigate).not.toHaveBeenCalled();
    await i18n.setLocale("pt-BR");
    await waitForSolid(() => {
      expect(selected.textContent).toBe(i18n.t("tabs.sessions"));
      expect(worktrees.textContent).toBe(i18n.t("tabs.worktrees"));
    });
    worktrees.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith("worktrees");
  } finally {
    navigate.mockRestore();
    dispose();
    await i18n.setLocale(locale);
  }
});

it("retires a held delete before rendering the destination route and ignores its late failure", async () => {
  const pending = createDeferred<{ deleted: boolean }>();
  const row = {
    key: "agent:main:route-retirement",
    sessionId: "route-retirement-id",
    kind: "direct" as const,
    label: "Held deletion session",
    updatedAt: 1,
  };
  const request = vi.fn((method: string) => {
    if (method === "sessions.list") {
      return sessionsResult([row]);
    }
    if (method === "sessions.delete") {
      return pending.promise;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const dialogs = createModalDialogTestFixture();
  const { context, container, dispose } = await mountSessionsRoute(request);
  const deletion = vi.spyOn(context.sessions, "deleteMany");
  try {
    let trigger: HTMLButtonElement | null = null;
    await waitForSolid(() => {
      trigger = container.querySelector(
        'openclaw-sessions-page .session-actions button[aria-haspopup="menu"]',
      );
      expect(trigger).not.toBeNull();
      expect(container.textContent).toContain(row.label);
    });
    trigger!.click();
    let menu: HTMLElementTagNameMap["openclaw-session-menu"] | null = null;
    await waitForSolid(() => {
      menu = container.querySelector("openclaw-session-menu");
      expect(menu).not.toBeNull();
    });
    await openSubmenu(menu!, "Advanced");
    await selectMenuValue(menu!, "delete");
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await waitForSolid(() => {
      expect(request.mock.calls.filter(([method]) => method === "sessions.delete")).toHaveLength(1);
      expect(container.textContent).toContain("Working…");
    });

    await context.navigateAndWait("about");
    await waitForSolid(() => {
      expect(container.querySelector("openclaw-about-page .about-hero__name")?.textContent).toBe(
        "OpenClaw",
      );
      expect(container.querySelector("openclaw-sessions-page")).toBeNull();
      expect(container.textContent).not.toContain(row.label);
      expect(container.textContent).not.toContain("Working…");
    });

    pending.reject(new Error("Late deleted-session failure"));
    await Promise.allSettled([deletion.mock.results[0]!.value]);
    await waitForSolid(() => {
      expect(container.querySelector("openclaw-about-page .about-hero__name")?.textContent).toBe(
        "OpenClaw",
      );
      expect(container.querySelector("openclaw-sessions-page")).toBeNull();
      expect(document.body.textContent).not.toContain("Late deleted-session failure");
    });
  } finally {
    pending.resolve({ deleted: false });
    dispose();
    await dialogs.cleanup();
  }
});
