import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createPageOpener } from "./new-session-page.scenario.test-support.ts";
import {
  captureProjectUiProof,
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const openPage = createPageOpener(suite);

suite.define(() => {
  it.each(["local", "required", "required-pending"] as const)(
    "starts a guest with default-project selection: %s",
    async (scenario) => {
      const required = scenario !== "local";
      const pending = scenario === "required-pending";
      const page = await openPage();
      const gateway = await installMockGateway(page, {
        workspace: "/workspace",
        operatorScopes: ["operator.sessions.write"],
        deferredRequests: pending ? [{ method: "projects.list" }] : [],
        featureMethods: [
          "projects.list",
          "projects.checkoutOptions",
          "sessions.create",
          "environments.list",
        ],
        methodResponses: {
          "agents.list": {
            agents: [
              { id: "main", name: "OpenClaw", workspace: "/workspace", workspaceGit: false },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
            sessionPlacement: required
              ? {
                  requiredProfile: {
                    id: "dedicated",
                    providerId: "device",
                    executionModes: ["worker-turn"],
                  },
                }
              : {},
          },
          "environments.list": {
            environments: [],
            profiles: required
              ? [{ id: "dedicated", providerId: "device", executionModes: ["worker-turn"] }]
              : [],
          },
          "projects.list": {
            projects: [
              {
                id: "openclaw",
                displayName: "OpenClaw",
                repositoryIdentity: "openclaw/openclaw",
                source: "registered",
              },
            ],
            defaultProjectId: "openclaw",
          },
          "projects.checkoutOptions": { current: true, worktree: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const trigger = page.locator("#new-session-project-trigger");
      await gateway.waitForRequest("projects.list");
      if (required) {
        await page.locator("[data-required-placement]").waitFor();
      } else {
        await pollLocatorText(trigger).toContain("openclaw/openclaw");
        await captureProjectUiProof(suite, page, "default-project.png");
      }
      if (captureUiProofEnabled && !required) {
        await writeFile(
          path.join(suite.artifactDir, "project-bounds.json"),
          JSON.stringify({ viewport: page.viewportSize(), bounds: await trigger.boundingBox() }),
        );
      }
      await page.locator(".new-session-page__message").fill("Inspect the project");
      const start = page.getByRole("button", { name: "Start session", exact: true });
      await expect
        .poll(async () => {
          if (await start.isEnabled()) {
            return "ready";
          }
          const description = await start.getAttribute("aria-describedby");
          return description
            ? await page.locator(`[id="${description}"]`).textContent()
            : "disabled";
        })
        .toBe("ready");
      await start.click();
      const request = await gateway.waitForRequest("sessions.create");
      if (pending) {
        expect(request.params).not.toHaveProperty("projectId");
        expect(request.params).not.toHaveProperty("worktree");
      } else {
        expect(request.params).toMatchObject({ projectId: "openclaw", worktree: true });
      }
      expect(request.params).not.toHaveProperty("projectGitUrl");
      expect(request.params).not.toHaveProperty("worktreeSource");
    },
  );
});
