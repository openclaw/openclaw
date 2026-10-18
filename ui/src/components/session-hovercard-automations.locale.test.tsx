/* @vitest-environment jsdom */
import { expect, it, onTestFinished } from "vitest";
import type { CronJob } from "../api/types.ts";
import { i18n } from "../i18n/index.ts";
import { captureI18nStateForTesting } from "../i18n/lib/translate.test-support.ts";
import { registerGitHubEnglish } from "../i18n/locales/en-github.ts";
import { registerEnglishCatalog } from "../lib/reactive/i18n.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { SessionHovercardAutomations } from "./session-hovercard-automations.tsx";

registerEnglishCatalog(registerGitHubEnglish);

it("updates retained automation labels and schedule without reloading its jobs", async () => {
  const restoreI18n = captureI18nStateForTesting();
  await i18n.setLocale("en");
  const job: CronJob = {
    id: "example",
    name: "Example automation",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 300_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Check the synthetic example." },
    state: {},
  };
  const request = createGatewayRequestMock(async () => ({
    jobs: [job],
    snapshotRevision: "example",
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
  const view = mountSolid(() => (
    <SessionHovercardAutomations
      automation={{
        gateway: source.gateway,
        sessionKey: "agent:main:example",
        agentId: "main",
        href: "/automations?session=agent%3Amain%3Aexample&agent=main",
        navigate: () => {},
      }}
    />
  ));
  onTestFinished(async () => {
    view.unmount();
    await restoreI18n();
  });
  await waitForSolid(() => {
    expect(view.container.querySelector(".session-hovercard__automation-name")?.textContent).toBe(
      "Example automation",
    );
    expect(view.container.textContent).toContain("Every 5m");
  });
  const tooltip = view.container.querySelector("openclaw-tooltip");
  const content = view.container.querySelector(".session-hovercard__automations");
  const link = view.container.querySelector<HTMLAnchorElement>(
    ".session-hovercard__automation-open",
  )!;
  expect(content?.getAttribute("aria-label")).toBe("Automations");
  const trigger = view.container.querySelector<HTMLAnchorElement>(
    ".session-hovercard__automation-link",
  )!;
  trigger.focus();

  await i18n.setLocale("de");
  await waitForSolid(() => {
    expect(content?.getAttribute("aria-label")).toBe("Automatisierungen");
    expect(content?.textContent).toContain("Every 5 Min.");
    expect(trigger.closest("openclaw-tooltip")).toBe(tooltip);
    expect(content?.querySelector(".session-hovercard__automation-open")).toBe(link);
    expect(document.activeElement).toBe(trigger);
    expect(request).toHaveBeenCalledTimes(1);
  });

  source.publish({ ...source.gateway.snapshot, phase: "offline", client: null });
  await waitForSolid(() =>
    expect(content?.querySelector('[role="status"]')?.textContent).toBe(
      "Automatisierungen für diese Sitzung nicht verfügbar.",
    ),
  );
  await i18n.setLocale("en");
  await waitForSolid(() => {
    expect(content?.querySelector('[role="status"]')?.textContent).toBe(
      "Automations unavailable for this session.",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});
