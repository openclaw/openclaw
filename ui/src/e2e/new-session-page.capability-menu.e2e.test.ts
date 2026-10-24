import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const draftAccess = {
  allowedSessionVisibilities: ["shared", "draft"],
  hasMultipleSessionSharingIdentities: true,
  operatorScopes: ["operator.read", "operator.write", "operator.admin"],
} satisfies NonNullable<Parameters<typeof installMockGateway>[1]>;
const config = {
  mcp: { servers: { github: { enabled: true, url: "https://mcp.example.test" } } },
  tools: { web: { search: { provider: "brave" } } },
};
const methodResponses = {
  "config.get": {
    raw: JSON.stringify(config),
    hash: "new-session-capabilities",
    sourceConfig: config,
    runtimeConfig: config,
    config,
  },
  "skills.status": {
    skills: [
      {
        name: "Release",
        skillKey: "release",
        disabled: false,
        blockedByAllowlist: false,
        missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
      },
    ],
  },
  "sessions.create": { key: "agent:main:new-session-capabilities", runStarted: true },
};

suite.define(() => {
  it.each([
    ["desktop", 1280, 900],
    ["mobile", 390, 844],
    ["atomic submission", 555, 1200],
  ] as const)("supports Draft capabilities on %s", async (mode, width, height) => {
    await suite.withPage({ viewport: { width, height } }, async ({ page }) => {
      const atomic = mode === "atomic submission";
      const gateway = await installMockGateway(
        page,
        atomic ? { ...draftAccess, methodResponses } : draftAccess,
      );
      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__composer");
      const menu = composer.locator(".agent-chat__capability-menu");
      const draft = menu.getByRole("menuitemcheckbox", { name: "Draft" });
      await composer.getByRole("button", { name: "Add attachment" }).click();
      if (atomic) {
        await expect.poll(() => draft.getAttribute("aria-checked")).toBe("false");
        await draft.focus();
        await page.keyboard.press("Space");
        await expect.poll(() => draft.getAttribute("aria-checked")).toBe("true");
      } else {
        await draft.click();
        await expect
          .poll(() => composer.locator(".new-session-page__visibility--draft").isVisible())
          .toBe(mode === "desktop");
        await expect
          .poll(() => page.locator(".new-session-page__draft-toggle").isVisible())
          .toBe(mode === "mobile");
        return;
      }
      await menu.getByRole("menuitem", { name: /^Skills/ }).click();
      const release = menu.getByRole("menuitemcheckbox", { name: "Release" });
      await release.click();
      await menu.getByRole("menuitem", { name: "Back" }).click();
      await menu.getByRole("menuitem", { name: /^Plugins/ }).click();
      await menu.getByRole("menuitemcheckbox", { name: /^github/ }).click();
      await menu.getByRole("menuitem", { name: "Back" }).click();
      await menu.getByRole("menuitemcheckbox", { name: "Web search" }).click();
      await page.locator(".new-session-page__message").fill("prepare the release");
      await composer.getByRole("button", { name: "Start session" }).click();
      expect((await gateway.waitForRequest("sessions.create")).params).toMatchObject({
        agentId: "main",
        message: "prepare the release",
        visibility: "draft",
        toolOverrides: {
          mcpServers: { github: false },
          skills: { release: false },
          webSearch: false,
        },
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    });
  });
});
