import { expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cloud-session placement identity",
  startServer: startControlUiE2eServer,
});

suite.define(() => {
  it("shows the cloud service, profile, and machine in the placement menu", async () => {
    const now = Date.now();
    const session: GatewaySessionRow = {
      key: "agent:main:cloud-identity",
      kind: "direct",
      label: "Cloud identity",
      updatedAt: now,
      placement: {
        state: "active",
        generation: 1,
        createdAtMs: now - 60_000,
        updatedAtMs: now,
        stateChangedAtMs: now - 30_000,
        environmentId: "worker:9f2c4e7a81d24b06a5c3f8e1b7d94c1a",
        providerId: "machine0",
        profileId: "team",
        machine: { class: "medium", os: "linux", osLabel: "Linux", cpu: 4, memoryGb: 16 },
        activeOwnerEpoch: 1,
        workerBundleHash: "a".repeat(64),
        workspaceBaseManifestRef: "sha256:cloud-identity-base",
        remoteWorkspaceDir: "/workspace/cloud-identity",
      },
    };
    const sessions: SessionsListResult = {
      count: 1,
      defaults: { contextTokens: null, model: "gpt-5.6-luna", modelProvider: "openai" },
      path: "",
      sessions: [session],
      ts: now,
    };
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: session.key,
          methodResponses: { "sessions.list": sessions },
        });
        const response = await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("sessions.list");
        const chip = page.locator(".chat-pane__placement-chip");
        await expect.poll(() => chip.textContent()).toBe("machine0 · team");
        await chip.click();
        const facts = page.locator(".chat-pane__placement-facts");
        await facts.waitFor({ state: "visible" });
        for (const [label, value] of [
          ["Service", "machine0"],
          ["Profile", "team"],
          ["Machine", "…d94c1a"],
        ]) {
          const term = facts.locator("dt", { hasText: label });
          expect(await term.locator("+ dd").textContent()).toBe(value);
        }
        await page.keyboard.press("Escape");
        const sidebarRow = page.locator(
          `.sidebar-recent-session[data-session-key="${session.key}"]`,
        );
        expect(
          await sidebarRow.locator(".session-row-badge--cloud").getAttribute("aria-label"),
        ).toBe("machine0 · team · Linux · medium · 4 vCPU · 16 GB · active");
        await sidebarRow.hover();
        const context = page.locator(
          '.session-hovercard__context-row[aria-label="Runs on machine0 · team"]',
        );
        await context.waitFor({ state: "visible" });
        expect(await context.textContent()).toContain("machine0 · team");
        const machine = page.locator(".session-hovercard__machine");
        expect(await machine.getAttribute("aria-label")).toBe(
          "Machine: Linux · medium · 4 vCPU · 16 GB",
        );
        expect(await machine.textContent()).toMatch(/^\s*Linux\s*medium\s*4 vCPU\s*16 GB\s*$/u);
      },
    );
  });
});
