/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../../src/gateway/control-ui-contract.js";
import { GatewayRequestError } from "../api/gateway-connect-errors.ts";
import { sessionProgressCardsForGateway } from "../lib/session-progress-cards.ts";
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
      "GitHub status could not be refreshed. Showing the last known state; check GitHub for the latest.",
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
