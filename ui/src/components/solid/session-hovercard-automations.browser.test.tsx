import { expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { CronJob } from "../../api/types.ts";
import { registerGitHubEnglish } from "../../i18n/locales/en-github.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createPortaledHovercard, PortaledHovercardController } from "../portaled-hovercard.ts";
import { SessionHovercardAutomations } from "../session-hovercard-automations.tsx";
import "../session-hovercard.css";

registerGitHubEnglish();

it("tabs into a nested inspection, dismisses only the flyout with Escape, and retires disconnected definitions", async () => {
  const job: CronJob = {
    id: "inspection",
    name: "Check repository",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 300000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Check the repository and report actionable failures." },
    state: {},
  };
  const request = createGatewayRequestMock(async () => ({
    jobs: [job],
    snapshotRevision: "one",
    total: 1,
    offset: 0,
    limit: 20,
    nextOffset: null,
    hasMore: false,
  }));
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
  const controller = new PortaledHovercardController(() => controller.reset());
  controller.markTrigger(trigger);
  controller.mount(trigger, card, "horizontal");
  const view = mountSolid(
    () => (
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
  await vi.waitFor(() => expect(anchor.textContent).toBe("Check repository"));
  await userEvent.click(anchor);
  const tooltip = card.querySelector("openclaw-tooltip")!;
  await vi.waitFor(() => expect(tooltip.hasAttribute("open")).toBe(true));
  anchor.focus();
  await userEvent.tab();
  const summary = card.querySelector("summary")!;
  expect(document.activeElement).toBe(summary);
  await userEvent.keyboard("{Enter}");
  expect(card.querySelector("details")!.open).toBe(true);
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(tooltip.hasAttribute("open")).toBe(false));
  expect(controller.card).toBe(card);
  expect(document.activeElement).toBe(anchor);
  source.publish({ ...source.gateway.snapshot, phase: "offline", client: null });
  flush();
  expect(card.textContent).not.toContain("Check the repository and report actionable failures.");
  expect(card.textContent).toContain("Automations unavailable for this session.");
});
