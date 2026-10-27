/* @vitest-environment jsdom */

import type { JSX } from "@solidjs/web";
import { render as mountSolid } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ApplicationContext } from "../app/context.ts";
import { NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT } from "../app/native-link-routing.ts";
import { createApplicationOverlays } from "../app/overlays.ts";
import { updateRunHarness } from "../app/update-run.test-support.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import type { SidebarAttentionItem } from "./sidebar-attention-entries.ts";
import { resolveSidebarUpdateAttention } from "./sidebar-attention-update.ts";
import { inboxMention } from "./sidebar-inbox.test-support.ts";
import {
  SidebarIssueItem,
  renderSidebarMentionItem as SidebarMentionItem,
  renderSidebarScopeUpgradeItem,
  renderSidebarUpdateSurface,
} from "./sidebar-issue-item.tsx";

const item: SidebarAttentionItem = {
  type: "attention",
  category: "automations",
  dismissal: null,
  requiresAction: true,
  kind: "cronFailed",
  severity: "error",
  icon: "clock",
  label: "Nightly backup",
  detail: "Failed now",
  action: { kind: "navigate", routeId: "cron" },
  signature: "backup",
};

const container = document.createElement("div");
const overlayDisposers: Array<() => void> = [];
function find(selector: string) {
  return container.querySelector<HTMLElement>(selector);
}
let dispose: (() => void) | undefined;
function render(view: (() => JSX.Element) | null) {
  dispose?.();
  if (view && !container.isConnected) {
    document.body.append(container);
  }
  dispose = view ? mountSolid(view, container) : undefined;
  flush();
}

afterEach(() => {
  render(null);
  overlayDisposers.splice(0).forEach((stop) => stop());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("renders a dismiss control only when the producer supplies the action", () => {
  const shared = { basePath: "", onNavigate: vi.fn(), onOpen: vi.fn() };
  render(() => <SidebarIssueItem item={item} handlers={shared} />);
  expect(find(".sidebar-issues-panel__dismiss")).toBeNull();
  const onDismiss = vi.fn();
  render(() => <SidebarIssueItem item={item} handlers={{ ...shared, onDismiss }} />);
  find(".sidebar-issues-panel__dismiss")?.click();
  expect(onDismiss).toHaveBeenCalledOnce();
});

it("shows the exact approval command for the pending access request", () => {
  const requestId = "request-1";
  render(() =>
    renderSidebarScopeUpgradeItem({
      state: { phase: "pending", requestId },
      onCancel: vi.fn(),
      onRequest: vi.fn(),
      onRetry: vi.fn(),
    }),
  );
  expect(find('[role="status"]')?.textContent).toContain(`openclaw devices approve ${requestId}`);
});

describe("renderSidebarMentionItem", () => {
  const mention = inboxMention("mention-riley");
  const pathname = "/team/chat/writer/chat/12345678-90ab-cdef-1234-567890abcdef";
  const navigation = { pathname, search: undefined };

  function renderMention(overrides: Partial<Parameters<typeof SidebarMentionItem>[0]> = {}) {
    const params = {
      mention,
      context: { basePath: "/team" },
      dismissing: false,
      canDismiss: true,
      onDismiss: vi.fn(),
      onNavigate: vi.fn(),
      ...overrides,
    };
    render(() => <SidebarMentionItem {...params} />);
    return params;
  }

  it("expands the thread-titled mention and opens its session without dismissing it", async () => {
    vi.useFakeTimers({ now: mention.createdAt + 5 * 60_000 });
    const excerpt = '<img src="about:blank" onerror="alert(1)"> & **release notes**';
    const { onNavigate, onDismiss } = renderMention({ mention: { ...mention, excerpt } });
    const renderedExcerpt = find(".sidebar-mention-row__excerpt")!;
    expect(renderedExcerpt).toMatchObject({ textContent: excerpt, childElementCount: 0 });
    expect(renderedExcerpt.closest(".sidebar-issues-panel__body")).not.toBeNull();
    await container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-relative-time",
    )?.updateComplete;
    const details = container.querySelector("details")!;
    const summary = details.querySelector("summary")!;
    const title = summary.querySelector(".sidebar-issues-panel__entity")!;
    expect(title.textContent).toBe("Release notes");
    expect(title.nextElementSibling?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Riley mentioned you · 5m ago",
    );
    expect(container.querySelectorAll("[data-issue-row-focus]")).toHaveLength(1);
    expect(summary.hasAttribute("data-issue-row-focus")).toBe(true);
    expect(details).toMatchObject({ open: false });
    summary.click();
    expect(details.open).toBe(true);
    const open = container.querySelector<HTMLAnchorElement>("a[href]")!;
    expect(open.getAttribute("href")).toBe(pathname);
    expect(open.closest(".sidebar-issues-panel__body")).not.toBeNull();
    const nativeClick = vi.fn((event: MouseEvent) => {
      const preserved = !event.defaultPrevented;
      event.preventDefault(); // Avoid jsdom navigation after verifying the native-link behavior.
      return preserved;
    });
    open.addEventListener("click", nativeClick, { once: true });
    open.dispatchEvent(new MouseEvent("click", { metaKey: true, cancelable: true }));
    expect(nativeClick).toHaveReturnedWith(true);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    open.click();
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("chat", navigation);
    expect(onDismiss).not.toHaveBeenCalled();
    summary.click();
    const dismiss = summary.querySelector<HTMLButtonElement>("button")!;
    expect(dismiss.getAttribute("aria-label")).toBe("Dismiss Release notes");
    dismiss.click();
    expect(details.open).toBe(false);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it.each([{ dismissing: true }, { canDismiss: false }])(
    "disables unavailable dismissal while leaving the session link usable (%j)",
    (state) => {
      const { onNavigate, onDismiss } = renderMention(state);
      const dismiss = container.querySelector<HTMLButtonElement>("[data-mention-id] button")!;
      expect(dismiss).toMatchObject({ disabled: true });
      dismiss.click();
      expect(onDismiss).not.toHaveBeenCalled();

      find("summary")!.click();
      find("a[href]")!.click();
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith("chat", navigation);
    },
  );
});

function updateFixture(
  request: Parameters<typeof updateRunHarness>[0],
  hello: Partial<NonNullable<ApplicationContext["gateway"]["snapshot"]["hello"]>> = {},
) {
  const harness = updateRunHarness(request);
  harness.update({
    hello: {
      ...harness.gateway.snapshot.hello!,
      features: { methods: ["update.run", "update.status"] },
      ...hello,
    },
  });
  const overlays = createApplicationOverlays(harness.gateway);
  overlayDisposers.push(() => overlays.dispose());
  return { ...harness, overlays, context: { gateway: harness.gateway, overlays } };
}
function renderUpdate(
  context: Pick<ApplicationContext, "gateway" | "overlays">,
  onDismiss?: () => void,
) {
  render(() =>
    renderSidebarUpdateSurface({
      context,
      onDismiss,
      onNavigate: vi.fn(),
      watchUpdateProgress: undefined,
    }),
  );
  return container.querySelector<HTMLElement>("openclaw-sidebar-update-card")!;
}
const freshStatusCall = ["update.status", { refreshCheckout: true }, { timeoutMs: null }] as const;
describe("renderSidebarUpdateSurface", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("localStorage", createStorageMock());
  });
  it.each([false, true])(
    "prepares retry from live application state after the card unmounts with access revoked=%s",
    async (revokeAccess) => {
      const entered = createDeferred();
      const response = createDeferred<unknown>();
      const run = createUpdateRunFixture({
        status: "failed",
        phase: "finished",
        reason: "build-failed",
        finishedAtMs: Date.now(),
      });
      const request = vi
        .fn(async () => {
          entered.resolve();
          return response.promise;
        })
        .mockResolvedValueOnce({ lastRun: run });
      const harness = updateFixture(request);
      const fresh = {
        channel: "dev",
        currentVersion: "1.0.0",
        latestVersion: "1.0.0",
        currentSha: "a".repeat(40),
        upstreamSha: "c".repeat(40),
        upstreamRef: "origin/main",
        commitsBehind: 9,
      };
      const restoreDialog = installDialogPolyfill();
      try {
        await vi.waitFor(() => expect(harness.overlays.snapshot.updateRun?.runId).toBe(run.runId));
        const card = renderUpdate(harness.context);
        card.querySelector<HTMLButtonElement>(".sidebar-update-card__action")!.click();
        const { modal } = await getRenderedModalDialog(document.body);
        render(null);
        expect(card.isConnected).toBe(false);
        const retry = [...modal.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Retry update",
        );
        expect(retry).toBeDefined();
        retry!.click();
        await entered.promise;
        if (revokeAccess) {
          harness.update({
            hello: {
              ...harness.gateway.snapshot.hello!,
              auth: { role: "operator", scopes: ["operator.read"] },
            },
          });
        }
        response.resolve({ updateAvailable: fresh });
        if (revokeAccess) {
          await vi.waitFor(() =>
            expect(modal.textContent).toContain(
              "Status could not be refreshed. Check your connection and try again.",
            ),
          );
          expect(modal.querySelector(".update-confirmation-details")).toBeNull();
        } else {
          await vi.waitFor(() => expect(modal.textContent).toContain("cccccccc"));
          expect(modal.textContent).toContain("9 commits behind");
        }
        expect(request).toHaveBeenCalledWith(...freshStatusCall);
        expect(request).not.toHaveBeenCalledWith(
          "update.run",
          expect.anything(),
          expect.anything(),
        );
      } finally {
        response.resolve({ updateAvailable: fresh });
        await vi.dynamicImportSettled();
        document
          .querySelector("openclaw-modal-dialog")
          ?.dispatchEvent(new CustomEvent("modal-cancel"));
        restoreDialog();
      }
    },
  );

  it.each([
    ["operator.read", "update.status", false, false],
    ["operator.admin", "update.status", true, false],
    ["operator.admin", "update.run", false, true],
  ] as const)(
    "gates discovery and fresh confirmation for %s with %s",
    async (scope, method, canCheck, canNativeUpdate) => {
      const request = vi.fn(async () => ({}));
      const harness = updateFixture(request, {
        auth: { role: "operator", scopes: [scope] },
        features: { methods: [method] },
      });
      const card = renderUpdate(harness.context, vi.fn());
      vi.stubGlobal("webkit", { messageHandlers: { openclawUpdate: { postMessage: vi.fn() } } });
      window.dispatchEvent(new Event(NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT));
      flush();
      expect(
        card.querySelector(".sidebar-update-card__action")?.getAttribute("aria-disabled"),
      ).toBe(canNativeUpdate ? null : "true");
      vi.stubGlobal("webkit", undefined);
      window.dispatchEvent(new Event(NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT));
      flush();
      expect(
        card.querySelector(".sidebar-update-card__action")?.getAttribute("aria-disabled"),
      ).toBe("true");
      const details = card.querySelector("details")!;
      const expanded = new Promise<void>((resolve) => {
        details.addEventListener("toggle", () => resolve(), { once: true });
      });
      details.open = true;
      await expanded;
      flush();
      if (canCheck) {
        expect(request).toHaveBeenCalledWith(...freshStatusCall);
      } else {
        expect(request).not.toHaveBeenCalledWith(
          "update.status",
          { refreshCheckout: true },
          expect.anything(),
        );
        expect(card.textContent).not.toContain("Could not check");
      }
    },
  );
  it.each(["acknowledged", "visible"] as const)(
    "dismisses the producer's current notice beside a %s terminal run",
    async (state) => {
      const run = createUpdateRunFixture({
        status: "succeeded",
        phase: "finished",
        finishedAtMs: Date.now(),
      });
      const { overlays, context } = updateFixture(
        async () => ({
          lastRun: run,
          updateAvailable: { currentVersion: "2.0.0", latestVersion: "3.0.0", channel: "stable" },
        }),
        { server: { version: "2.0.0", bootId: "fixture-boot" } },
      );
      await overlays.refreshUpdateStatus();
      if (state === "acknowledged") {
        overlays.acknowledgeUpdateRun();
      }
      const dismissal = resolveSidebarUpdateAttention(context)?.dismissal;
      const expected = {
        kind: "updateAvailable",
        signature: JSON.stringify(
          state === "visible" ? ["run", run.runId] : ["3.0.0", "fixture-boot"],
        ),
      };
      const dismiss = vi.fn();
      renderUpdate(context, () => dismiss(dismissal));
      flush();
      expect(container.textContent).toContain(state === "visible" ? "OpenClaw updated" : "3.0.0");
      find(".sidebar-issues-panel__dismiss")!.click();
      expect(dismiss).toHaveBeenCalledExactlyOnceWith(expected);
      expect(overlays.snapshot.updateRunAcknowledged).toBe(state === "acknowledged");
    },
  );
});
