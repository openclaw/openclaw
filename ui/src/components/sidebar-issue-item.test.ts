/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createApplicationOverlays } from "../app/overlays.ts";
import type { ConfirmAndStartUpdateParams } from "../app/update-confirmation.ts";
import { updateRunHarness } from "../app/update-run.test-support.ts";
import { SESSION_NAVIGATION_KEY_PARAM } from "../lib/sessions/route-navigation.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import type { SidebarAttentionItem } from "./sidebar-attention-entries.ts";
import { resolveSidebarUpdateAttention } from "./sidebar-attention-update.ts";
import {
  renderSidebarIssueItem,
  renderSidebarMentionItem,
  renderSidebarScopeUpgradeItem,
  renderSidebarUpdateSurface,
} from "./sidebar-issue-item.ts";

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

afterEach(() => {
  render(null, container);
});

describe("renderSidebarIssueItem", () => {
  it("renders a dismiss control only when the producer supplies the action", () => {
    const shared = {
      basePath: "",
      onNavigate: vi.fn(),
      onOpen: vi.fn(),
    };
    render(renderSidebarIssueItem(item, shared), container);
    expect(container.querySelector(".sidebar-issues-panel__dismiss")).toBeNull();

    const onDismiss = vi.fn();
    render(renderSidebarIssueItem(item, { ...shared, onDismiss }), container);
    container.querySelector<HTMLButtonElement>(".sidebar-issues-panel__dismiss")?.click();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe("renderSidebarScopeUpgradeItem", () => {
  it("shows the exact approval command for the pending access request", () => {
    render(
      renderSidebarScopeUpgradeItem({
        state: { phase: "pending", requestId: "9c21fe9d-6f53-4420-a273-f447920314dd" },
        onCancel: vi.fn(),
        onRequest: vi.fn(),
        onRetry: vi.fn(),
      }),
      container,
    );

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "openclaw devices approve 9c21fe9d-6f53-4420-a273-f447920314dd",
    );
  });
});

describe("renderSidebarMentionItem", () => {
  beforeEach(() => {
    document.body.append(container);
  });
  afterEach(() => {
    container.remove();
    vi.useRealTimers();
  });

  const mention: MentionInboxItem = {
    id: "mention-riley",
    senderProfileId: "profile-riley",
    senderLabel: "Riley",
    sessionKey: "agent:writer:chat:12345678-90ab-cdef-1234-567890abcdef",
    agentId: "writer",
    sessionTitle: "Release notes",
    messageId: "message-1",
    createdAt: 1_780_000_000_000,
    expiresAt: 1_780_003_600_000,
    excerpt: "Can you review the release notes?",
  };
  const pathname = "/team/chat/writer/chat/12345678-90ab-cdef-1234-567890abcdef";
  const navigation = {
    pathname,
    search: `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(mention.sessionKey)}`,
  };

  function renderMention(overrides: Partial<Parameters<typeof renderSidebarMentionItem>[0]> = {}) {
    const params = {
      mention,
      context: { basePath: "/team" },
      dismissing: false,
      onDismiss: vi.fn(),
      onNavigate: vi.fn(),
      ...overrides,
    };
    render(renderSidebarMentionItem(params), container);
    return params;
  }

  it("expands the thread-titled mention and opens its session without dismissing it", async () => {
    vi.useFakeTimers({ now: mention.createdAt + 5 * 60_000 });
    const { onNavigate, onDismiss } = renderMention();
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
    expect(summary.querySelector(".sidebar-issues-panel__chevron svg")).not.toBeNull();
    expect(container.querySelectorAll("[data-issue-row-focus]")).toHaveLength(1);
    expect(summary.hasAttribute("data-issue-row-focus")).toBe(true);
    expect(details.open).toBe(false);
    summary.click();
    expect(details.open).toBe(true);
    const open = container.querySelector<HTMLAnchorElement>("a[href]")!;
    expect(open.getAttribute("href")).toBe(pathname);
    expect(open.closest(".sidebar-issues-panel__body")).not.toBeNull();

    let nativeNavigationPreserved = false;
    open.addEventListener(
      "click",
      (event) => {
        nativeNavigationPreserved = !event.defaultPrevented;
        // Observe the renderer's native-link behavior without navigating jsdom.
        event.preventDefault();
      },
      { once: true },
    );
    open.dispatchEvent(new MouseEvent("click", { metaKey: true, cancelable: true }));
    expect(nativeNavigationPreserved).toBe(true);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();

    open.click();
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("chat", navigation);
    expect(onDismiss).not.toHaveBeenCalled();

    summary.click();
    const dismiss = summary.querySelector<HTMLButtonElement>("button")!;
    expect(dismiss.getAttribute("aria-label")).toBe("Dismiss Release notes");
    expect(dismiss.textContent?.trim()).toBe("");
    dismiss.click();
    expect(details.open).toBe(false);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it("preserves expansion for the same mention but collapses a replacement mention", () => {
    renderMention();
    container.querySelector("summary")!.click();
    expect(container.querySelector("details")?.open).toBe(true);

    renderMention({ mention: { ...mention, excerpt: "Updated release notes" } });
    expect(container.querySelector("details")?.open).toBe(true);

    renderMention({ mention: { ...mention, id: "mention-next", sessionTitle: "Next release" } });
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector("summary")?.textContent).toContain("Next release");
  });

  it("renders the message excerpt as text rather than HTML or Markdown", () => {
    const excerpt = '<img src="about:blank" onerror="alert(1)"> & **release notes**';
    renderMention({ mention: { ...mention, excerpt } });

    const renderedExcerpt = container.querySelector(".sidebar-mention-row__excerpt")!;
    expect(renderedExcerpt.textContent).toBe(excerpt);
    expect(renderedExcerpt.children).toHaveLength(0);
    expect(renderedExcerpt.closest(".sidebar-issues-panel__body")).not.toBeNull();
  });

  it("disables repeated dismissal while leaving the session link usable", () => {
    const { onNavigate, onDismiss } = renderMention({ dismissing: true });
    const dismiss = container.querySelector<HTMLButtonElement>("[data-mention-id] button")!;
    expect(dismiss.disabled).toBe(true);
    dismiss.click();
    expect(onDismiss).not.toHaveBeenCalled();

    container.querySelector("summary")!.click();
    container.querySelector<HTMLAnchorElement>("a[href]")!.click();
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("chat", navigation);
  });
});

describe("renderSidebarUpdateSurface", () => {
  beforeEach(() => {
    document.body.append(container);
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("localStorage", createStorageMock());
  });
  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it.each([false, true])(
    "prepares retry from live application state after the card unmounts with access revoked=%s",
    async (revokeAccess) => {
      const entered = createDeferred();
      const response = createDeferred<unknown>();
      const request = vi.fn(async () => {
        entered.resolve();
        return response.promise;
      });
      const harness = updateRunHarness(request);
      harness.update({
        hello: {
          ...harness.gateway.snapshot.hello!,
          features: { methods: ["update.run", "update.status"] },
        },
      });
      const overlays = createApplicationOverlays(harness.gateway);
      const fresh = {
        channel: "dev",
        currentVersion: "1.0.0",
        latestVersion: "1.0.0",
        currentSha: "a".repeat(40),
        upstreamSha: "c".repeat(40),
        upstreamRef: "origin/main",
        commitsBehind: 9,
      };
      let preparing: Promise<unknown> | undefined;
      try {
        render(
          renderSidebarUpdateSurface({
            context: { gateway: harness.gateway, overlays },
            onNavigate: vi.fn(),
            watchUpdateProgress: undefined,
          }),
          container,
        );
        const card = container.querySelector<
          HTMLElement & {
            updateComplete: Promise<boolean>;
            prepareRetry: NonNullable<ConfirmAndStartUpdateParams["prepareRetry"]>;
          }
        >("openclaw-sidebar-update-card")!;
        await card.updateComplete;
        render(null, container);
        expect(card.isConnected).toBe(false);
        preparing = card.prepareRetry();
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
        const target = await preparing;
        if (revokeAccess) {
          expect(target).toBeNull();
        } else {
          expect(target).toMatchObject({ updateAvailable: fresh });
        }
        expect(request).toHaveBeenCalledWith(
          "update.status",
          { refreshCheckout: true },
          { timeoutMs: null },
        );
      } finally {
        response.resolve({ updateAvailable: fresh });
        await preparing;
        overlays.dispose();
      }
    },
  );

  it.each([
    {
      scope: "operator.read",
      methods: ["update.status"],
      canCheck: false,
      canUpdate: false,
      canNativeUpdate: false,
    },
    {
      scope: "operator.admin",
      methods: ["update.status"],
      canCheck: true,
      canUpdate: false,
      canNativeUpdate: false,
    },
    {
      scope: "operator.admin",
      methods: ["update.run"],
      canCheck: false,
      canUpdate: false,
      canNativeUpdate: true,
    },
    {
      scope: "operator.admin",
      methods: ["update.run", "update.status"],
      canCheck: true,
      canUpdate: true,
      canNativeUpdate: true,
    },
  ])(
    "gates discovery and fresh confirmation for $scope with $methods",
    async ({ scope, methods, canCheck, canUpdate, canNativeUpdate }) => {
      const request = vi.fn(async () => ({}));
      const harness = updateRunHarness(request);
      harness.update({
        hello: {
          ...harness.gateway.snapshot.hello!,
          auth: { role: "operator", scopes: [scope] },
          features: { methods },
        },
      });
      const overlays = createApplicationOverlays(harness.gateway);
      try {
        render(
          renderSidebarUpdateSurface({
            context: { gateway: harness.gateway, overlays },
            onDismiss: vi.fn(),
            onNavigate: vi.fn(),
            watchUpdateProgress: undefined,
          }),
          container,
        );
        const card = container.querySelector<
          HTMLElement & {
            updateComplete: Promise<boolean>;
            canUpdate: boolean;
            canNativeUpdate: boolean;
            onCheckStatus?: () => Promise<boolean>;
          }
        >("openclaw-sidebar-update-card")!;
        await card.updateComplete;
        expect(card.canUpdate).toBe(canUpdate);
        expect(card.canNativeUpdate).toBe(canNativeUpdate);
        expect(Boolean(card.onCheckStatus)).toBe(canCheck);
        const details = card.querySelector("details")!;
        const expanded = new Promise<void>((resolve) => {
          details.addEventListener("toggle", () => resolve(), { once: true });
        });
        details.open = true;
        await expanded;
        await card.updateComplete;
        if (canCheck) {
          expect(request).toHaveBeenCalledWith(
            "update.status",
            { refreshCheckout: true },
            { timeoutMs: null },
          );
        } else {
          expect(request).not.toHaveBeenCalledWith(
            "update.status",
            { refreshCheckout: true },
            expect.anything(),
          );
          expect(card.textContent).not.toContain("Could not check");
        }
      } finally {
        overlays.dispose();
      }
    },
  );
  it.each(["acknowledged", "expired", "visible"] as const)(
    "dismisses the producer's current notice beside a %s terminal run",
    async (state) => {
      const run = createUpdateRunFixture({
        status: "succeeded",
        phase: "finished",
        finishedAtMs: Date.now() - (state === "expired" ? 25 * 60 * 60 * 1_000 : 0),
      });
      const harness = updateRunHarness(async () => ({
        lastRun: run,
        updateAvailable: { currentVersion: "2.0.0", latestVersion: "3.0.0", channel: "stable" },
      }));
      harness.update({
        hello: {
          ...harness.gateway.snapshot.hello!,
          server: { version: "2.0.0", bootId: "fixture-boot" },
          features: { methods: ["update.run", "update.status"] },
        },
      });
      const overlays = createApplicationOverlays(harness.gateway);
      const context = { gateway: harness.gateway, overlays };
      try {
        await overlays.refreshUpdateStatus();
        if (state === "acknowledged") {
          overlays.acknowledgeUpdateRun();
        }
        const dismissal = resolveSidebarUpdateAttention(context).dismissal;
        const expected = {
          kind: "updateAvailable",
          signature: JSON.stringify(
            state === "visible" ? ["run", run.runId] : ["3.0.0", "fixture-boot"],
          ),
        };
        const dismiss = vi.fn();
        render(
          renderSidebarUpdateSurface({
            context,
            onDismiss: () => dismiss(dismissal),
            onNavigate: vi.fn(),
            watchUpdateProgress: undefined,
          }),
          container,
        );
        const card = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
          "openclaw-sidebar-update-card",
        )!;
        await card.updateComplete;
        expect(container.textContent).toContain(state === "visible" ? "OpenClaw updated" : "3.0.0");
        container.querySelector<HTMLButtonElement>(".sidebar-issues-panel__dismiss")!.click();
        expect(dismiss).toHaveBeenCalledExactlyOnceWith(expected);
        expect(overlays.snapshot.updateRunAcknowledged).toBe(state === "acknowledged");
      } finally {
        overlays.dispose();
      }
    },
  );
});
