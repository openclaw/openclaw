import { expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { registerGitHubEnglish } from "../../i18n/locales/en-github.ts";
import { createCronJob, cronJobsListResponse } from "../../lib/cron/cron.test-support.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { controlsForHovercard, HovercardControlsContext } from "../portaled-hovercard-focus.ts";
import { createPortaledHovercard, createPortaledHovercardOwner } from "../portaled-hovercard.ts";
import { SessionHovercardAutomations } from "../session-hovercard-automations.tsx";
import "../session-hovercard.css";

registerGitHubEnglish();

it.each([1, 2])("keeps inspection focus and retires %i disconnected jobs", async (jobCount) => {
  const instruction = "Check the repository and report actionable failures.";
  const job = createCronJob("inspection", "Check repository", {
    schedule: { kind: "every", everyMs: 300000 },
    wakeMode: "now",
    payload: { kind: "agentTurn", message: instruction },
  });
  const request = createGatewayRequestMock(async () =>
    cronJobsListResponse(
      Array.from({ length: jobCount }, (_, index) => ({ ...job, id: `inspection-${index}` })),
      { snapshotRevision: "one", limit: 20 },
    ),
  );
  const source = createApplicationGateway();
  source.publish({
    ...source.gateway.snapshot,
    phase: "connected",
    client: createTestGatewayClient(request),
  });
  const trigger = document.createElement("a");
  trigger.href = "#conversation";
  trigger.textContent = "Conversation";
  trigger.style.cssText = "position:fixed;left:20px;top:30px;";
  document.body.append(trigger);
  const card = createPortaledHovercard("inspection-card", "session-progress-hovercard");
  card.style.cssText = "position:fixed;inset:auto;width:300px;padding:12px;";
  const controller = createPortaledHovercardOwner(() => controller.reset());
  controller.markTrigger(trigger);
  controller.mount(trigger, card, "horizontal");
  const view = mountSolid(
    () => (
      <HovercardControlsContext value={controlsForHovercard(card)}>
        <div class="session-hovercard__context">
          <SessionHovercardAutomations
            automation={{
              gateway: source.gateway,
              sessionKey: "agent:main:task",
              agentId: "main",
              href: "/automations?session=agent%3Amain%3Atask&agent=main",
              navigate: () => undefined,
            }}
          />
        </div>
      </HovercardControlsContext>
    ),
    { container: card },
  );
  onTestFinished(() => {
    view.unmount();
    controller.reset();
    trigger.remove();
  });
  flush();
  const anchor = card.querySelector<HTMLAnchorElement>(".session-hovercard__automation-link")!;
  await vi.waitFor(() => expect(card.querySelector("summary")).not.toBeNull());
  if (jobCount === 1) {
    expect(anchor.textContent).toBe("Check repository");
  }
  await userEvent.click(anchor);
  const tooltip = card.querySelector("openclaw-tooltip")!;
  await vi.waitFor(() => expect(tooltip.hasAttribute("open")).toBe(true));
  // WebKit pointer clicks may not focus anchors; start native Tab at the trigger.
  anchor.focus();
  const tabTo = async (target: Element, shift = false) => {
    await userEvent.tab({ shift });
    expect(document.activeElement).toBe(target);
  };
  const summary = card.querySelector("summary")!;
  const choices = card.querySelectorAll(".session-hovercard__automation-choice");
  const firstInspectionControl = jobCount === 1 ? summary : choices[0]!;
  await tabTo(firstInspectionControl);
  await tabTo(anchor, true);
  expect(controller.card).toBe(card);
  expect(tooltip.hasAttribute("open")).toBe(true);
  await tabTo(firstInspectionControl);
  // Only inner traversal needs macOS WebKit's Option-Tab; handoffs use plain Tab.
  const tabInside = () =>
    navigator.platform.includes("Mac") &&
    navigator.userAgent.includes("AppleWebKit") &&
    !navigator.userAgent.includes("Chrome")
      ? userEvent.keyboard("{Alt>}{Tab}{/Alt}")
      : userEvent.tab();
  if (jobCount === 2) {
    await tabInside();
    expect(document.activeElement).toBe(choices[1]);
    await tabInside();
    expect(document.activeElement).toBe(summary);
  }
  await userEvent.keyboard("{Enter}");
  expect(card.querySelector("details")!.open).toBe(true);
  await tabInside();
  expect(document.activeElement).toBe(card.querySelector(".session-hovercard__automation-open"));
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(tooltip.hasAttribute("open")).toBe(false));
  expect(controller.card).toBe(card);
  expect(document.activeElement).toBe(anchor);
  source.publish({ ...source.gateway.snapshot, phase: "offline", client: null });
  flush();
  expect(card.textContent).not.toContain(instruction);
  expect(card.textContent).toContain("Automations unavailable for this session.");
  await tabTo(trigger, true);
  expect(controller.card).toBeNull();
});
