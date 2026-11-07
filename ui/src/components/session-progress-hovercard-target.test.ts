/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../../src/gateway/control-ui-contract.js";
import { GatewayRequestError } from "../api/gateway-connect-errors.ts";
import type { ApplicationContext } from "../app/context.ts";
import { sessionProgressCardsForGateway } from "../lib/session-progress-cards.ts";
import { patchReceipt } from "../lib/sessions/session-rpc.test-support.ts";
import "../lib/toast-host.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { sessionProgressHoverTargetFromEvent } from "./session-progress-hovercard-target.ts";
import { createHovercard } from "./session-progress-hovercard.test-support.ts";

function mountHovercard(sessionKey = "global", holdProgress = false) {
  const h = createHovercard({ sessionKey, holdProgress });
  document.body.append(h.provider);
  flush();
  return h;
}

const getPortal = () => document.querySelector(".session-progress-hovercard");
const portalText = () => getPortal()?.textContent;

const expectPortalText = (text: string) => waitForSolid(() => expect(portalText()).toContain(text));

function matchPointer(tag: string, className: string, pointerType = "") {
  const host = document.body.appendChild(document.createElement("div"));
  const candidate = host.appendChild(document.createElement(tag));
  candidate.className = className;
  candidate.dataset.sessionKey = "agent:main:other-session";
  let matched: HTMLElement | null = null;
  host.addEventListener("pointerover", (event) => {
    matched = sessionProgressHoverTargetFromEvent(event);
  });
  candidate
    .appendChild(document.createElement("span"))
    .dispatchEvent(new PointerEvent("pointerover", { bubbles: true, composed: true, pointerType }));
  return { matched, candidate };
}

afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  flush();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sessionProgressHoverTargetFromEvent", () => {
  it.each([
    ["a chat link", "a", "markdown-session-link", "", true],
    ["a sidebar row", "div", "sidebar-recent-session", "", true],
    ["unrelated data", "button", "custom-session-control", "", false],
    ["touch input", "div", "sidebar-recent-session", "touch", false],
  ] as const)(
    "matches nested targets only for supported input: %s",
    (_label, tag, className, pointer, accepts) => {
      const { matched, candidate } = matchPointer(tag, className, pointer);
      expect(matched).toBe(accepts ? candidate : null);
    },
  );
});

describe("session progress hovercard ownership", () => {
  it("reads row facts through its shell callback without a descendant sidebar", async () => {
    vi.useFakeTimers();
    const harness = createHovercard({
      sessionKey: "agent:research:main",
      triggerKind: "markdown",
      rowDetails: { label: "Referenced session facts" },
    });
    harness.provider.querySelector("openclaw-app-sidebar")!.remove();
    document.body.append(harness.provider);
    flush();
    await harness.focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(portalText()).toContain("Referenced session facts");
  });

  it.each([
    [
      "rate-limited",
      "GitHub API rate limit reached. Pull request status may be out of date until the limit resets.",
    ],
    [
      "unavailable",
      "Couldn’t refresh GitHub status. Check GitHub for the latest; this is the last known status.",
    ],
  ] as const)(
    "updates a held hovercard when only PR lookup status becomes %s",
    async (status, warning) => {
      vi.useFakeTimers();
      const harness = mountHovercard("agent:research:main");
      await harness.focus();
      await vi.advanceTimersByTimeAsync(0);
      const portal = getPortal();
      expect(portal?.textContent).toContain("research progress");
      harness.emitPullRequestStatus("ready");
      flush();
      expect(portal?.querySelector('.session-hovercard__more[role="status"]')).toBeNull();

      harness.emitPullRequestStatus(status);
      flush();
      expect(
        portal?.querySelector('.session-hovercard__more[role="status"]')?.textContent?.trim(),
      ).toBe(warning);
      harness.emitPullRequestStatus("ready");
      flush();
      expect(portal?.querySelector('.session-hovercard__more[role="status"]')).toBeNull();
      expect(getPortal()).toBe(portal);
    },
  );

  it("updates location facts in a held hovercard", async () => {
    vi.useFakeTimers();
    const harness = mountHovercard("agent:research:main");
    harness.updateRow({ placementProviderId: "cloud-a", placementProfileId: "standard" });
    await harness.focus();
    await vi.advanceTimersByTimeAsync(0);
    const portal = getPortal();
    expect(portal?.textContent).toContain("cloud-a · standard");

    harness.updateRow({ placementProfileId: "large" });
    flush();
    expect(portal?.textContent).toContain("cloud-a · large");
    expect(getPortal()).toBe(portal);
  });

  it.each([true, false])(
    "removes denied progress from a held hovercard while retaining transient failures (denied: %s)",
    async (denied) => {
      const sessionKey = "agent:research:main";
      const harness = mountHovercard(sessionKey);
      await harness.focus();
      await expectPortalText("research progress");
      const error = denied
        ? new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Participation required",
            details: { code: "SESSION_PARTICIPATION_REQUIRED" },
          })
        : new Error("Temporary connection failure");
      harness.request.mockRejectedValueOnce(error);
      harness.emitProgressChange();
      await waitForSolid(() =>
        expect(sessionProgressCardsForGateway(harness.gateway).getError({ sessionKey })).toBe(
          denied ? "access-denied" : "unavailable",
        ),
      );
      expect(portalText()).toContain("research session");
      if (denied) {
        expect(portalText()).not.toContain("research progress");
      } else {
        expect(portalText()).toContain("research progress");
      }
    },
  );

  it.each([
    ["global", "agent:research:global", "research"],
    ["agent:other:main", "agent:other:main", "other"],
  ])(
    "uses the hovered session owner for progress and PR data: %s",
    async (sessionKey, artifactKey, agentId) => {
      const harness = mountHovercard(sessionKey);
      await harness.focus();
      await waitForSolid(() =>
        expect(harness.request).toHaveBeenCalledWith("progressCard.get", {
          sessionKey,
          ...(sessionKey === "global" ? { agentId } : {}),
        }),
      );
      await waitForSolid(() =>
        expect(harness.request).toHaveBeenCalledWith(
          SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          expect.objectContaining({ sessionKeys: [artifactKey] }),
          { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
        ),
      );
      expect(portalText()).toContain(`${agentId} progress`);
    },
  );

  it("dismisses the hovered failure with its unread marker and owner role", async () => {
    const patch = vi.fn<ApplicationContext["sessions"]["patch"]>(async () => null);
    const childKey = "agent:research:subagent:child";
    const harness = createHovercard({
      sessionKey: childKey,
      // Session-scoped writers may patch only sessions they own.
      scopes: ["operator.read", "operator.sessions.write"],
      sessionsPatch: patch,
      rowDetails: {
        attention: {
          kind: "error",
          reason: "Synthetic child failure",
          sourceSessionKey: childKey,
          sourceSessionId: "child-session",
          sourceMarkedUnreadAt: 100,
          sourceSharingRole: "owner",
        },
      },
    });
    document.body.append(harness.provider);
    flush();
    await harness.focus();
    const dismiss = () =>
      getPortal()?.querySelector<HTMLButtonElement>(".session-hovercard__error .btn") ?? null;
    await waitForSolid(() => expect(dismiss()).not.toBeNull());
    dismiss()!.click();
    await waitForSolid(() =>
      expect(patch).toHaveBeenCalledWith(
        childKey,
        { unread: false },
        { agentId: "research", expectedMarkedUnreadAt: 100, expectedSessionId: "child-session" },
      ),
    );
  });

  it("reports a rejected Dismiss and keeps it for a retry", async () => {
    const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));
    await toast.updateComplete;
    const patch = vi
      .fn<ApplicationContext["sessions"]["patch"]>(async (key) =>
        patchReceipt(key, { sessionId: "child-session", lastReadAt: 20 }),
      )
      .mockRejectedValueOnce(new Error("Session store unavailable"))
      .mockResolvedValueOnce(null);
    const harness = createHovercard({
      sessionKey: "agent:research:subagent:child",
      scopes: ["operator.read", "operator.write"],
      sessionsPatch: patch,
      rowDetails: {
        attention: {
          kind: "error",
          reason: "Synthetic child failure",
          sourceSessionKey: "agent:research:subagent:child",
          sourceSessionId: "child-session",
        },
      },
    });
    document.body.append(harness.provider);
    flush();
    await harness.focus();
    const dismiss = () =>
      getPortal()?.querySelector<HTMLButtonElement>(".session-hovercard__error .btn") ?? null;
    await waitForSolid(() => expect(dismiss()).not.toBeNull());
    dismiss()!.click();
    await waitForSolid(() =>
      expect(toast.toasts[0]?.options.message).toBe(
        "Couldn't mark as read. Try again. Session store unavailable",
      ),
    );
    expect(toast.toasts[0]?.options.severity).toBe("error");
    expect(dismiss()?.disabled).toBe(false);
    const messages = () => toast.toasts.map((entry) => entry.options.message);
    // A retired connection ends the retry without a receipt: still not read.
    dismiss()!.click();
    await waitForSolid(() => expect(patch).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(messages()).toEqual(["Couldn't mark as read. Try again. Session store unavailable"]);
    await waitForSolid(() => expect(dismiss()?.disabled).toBe(false));
    dismiss()!.click();
    await waitForSolid(() => expect(messages()).toEqual(["Marked as read"]));
    expect(patch).toHaveBeenCalledTimes(3);
  });

  it("offers no Dismiss for a restored failure without its session id", async () => {
    const harness = createHovercard({
      sessionKey: "agent:research:main",
      scopes: ["operator.read", "operator.write"],
      sessionsPatch: vi.fn<ApplicationContext["sessions"]["patch"]>(async () => null),
      rowDetails: {
        attention: {
          kind: "error",
          reason: "Synthetic child failure",
          sourceSessionKey: "agent:research:subagent:child",
        },
      },
    });
    document.body.append(harness.provider);
    flush();
    await harness.focus();
    await waitForSolid(() => expect(portalText()).toContain("Synthetic child failure"));
    expect(getPortal()?.querySelector(".session-hovercard__error .btn")).toBeNull();
  });

  it("retires a removed provider while its progress request is pending", async () => {
    const harness = mountHovercard("global", true);
    await harness.focus();
    await waitForSolid(() =>
      expect(harness.request).toHaveBeenCalledWith("progressCard.get", expect.anything()),
    );
    harness.provider.remove();
    await Promise.resolve();
    await harness.releaseProgress();
    flush();
    expect(getPortal()).toBeNull();
    const requests = harness.request.mock.calls.length;
    await harness.focus();
    expect(harness.request).toHaveBeenCalledTimes(requests);
  });

  it("retires an in-flight global hover when the sidebar owner changes", async () => {
    const harness = mountHovercard("global", true);
    await harness.focus();
    await waitForSolid(() =>
      expect(harness.request).toHaveBeenCalledWith("progressCard.get", expect.anything()),
    );
    await expectPortalText("research session");
    harness.select("main");
    expect(getPortal()).toBeNull();
    await harness.focus();
    await expectPortalText("main progress");
    await harness.releaseProgress();
    await waitForSolid(() => expect(portalText()).not.toContain("research progress"));
    expect(harness.request).toHaveBeenCalledWith("progressCard.get", {
      sessionKey: "global",
      agentId: "main",
    });
  });
});
