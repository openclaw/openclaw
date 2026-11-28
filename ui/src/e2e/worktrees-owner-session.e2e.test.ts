import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { WorktreeRecord } from "../../../packages/gateway-protocol/src/schema/worktrees.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Worktree owner session" });
const ownerKey = "agent:main:dashboard:ace01234-1111-4444-8888-112233445566";
const worktree: WorktreeRecord = {
  id: "worktree-release",
  name: "release-cleanup",
  repoFingerprint: "0123456789abcdef",
  repoRoot: "/synthetic/lobster",
  path: "/synthetic/worktrees/release-cleanup",
  branch: "worktree/release-cleanup",
  baseRef: "main",
  ownerKind: "session",
  ownerId: ownerKey,
  createdAt: 1_794_700_000_000,
  lastActiveAt: 1_794_700_000_000,
};

suite.define(() => {
  it("keeps the worktree usable while an off-roster owner resolves", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["worktrees.sessionOwners"],
        methodResponses: {
          "worktrees.list": { worktrees: [worktree] },
          "worktrees.sessionOwners": {
            sessions: [
              {
                requestedKey: ownerKey,
                key: ownerKey,
                agentId: "main",
                displayName: "Prepare the release",
                boardFace: "dashboard",
              },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}worktrees`);
      const request = await gateway.waitForRequest("worktrees.sessionOwners");
      expect(request.params).toEqual({ keys: [ownerKey] });
      const existing = page.getByRole("link", { name: "Session", exact: true });
      await existing.waitFor({ state: "visible" });
      expect(await existing.getAttribute("title")).toBeNull();
      expect(await page.getByRole("button", { name: "Delete: release-cleanup" }).isEnabled()).toBe(
        true,
      );
      await existing.focus();
      await gateway.resolveDeferred("worktrees.sessionOwners");
      const named = page.getByRole("link", { name: "Prepare the release", exact: true });
      await named.waitFor({ state: "visible" });
      expect(await named.getAttribute("title")).toBe("Prepare the release");
      expect(await named.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe(
        "underline",
      );
      expect((await named.getAttribute("href"))?.startsWith("/dashboard/")).toBe(true);
      expect(
        await named.evaluate((element) => element.ownerDocument.activeElement === element),
      ).toBe(true);
      expect(await gateway.getRequests("worktrees.list")).toHaveLength(1);
      expect(await gateway.getRequests("worktrees.sessionOwners")).toHaveLength(1);
      await named.blur();
      const surface = page.locator("openclaw-worktrees-page");
      const frame = await takeControlUiScreenshotFrame(page, surface, [named], {
        animations: "disabled",
        elements: [named],
      });
      await writeFile(path.join(suite.artifactDir, "after-clean.png"), frame.png);
      await writeFile(
        path.join(suite.artifactDir, "after-owner-bounds.json"),
        JSON.stringify(frame.elements[0]?.bounds),
      );
    });
  });

  it("keeps the time visible next to truncated worktree details in a narrow dark window", async () => {
    const branchName = "worktree/release-cleanup-and-backward-compatibility-review";
    const sessionName = "Prepare the release and review compatibility with older installations";
    await suite.withPage(
      { viewport: { width: 400, height: 850 }, colorScheme: "dark" },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "worktrees.list": { worktrees: [{ ...worktree, branch: branchName }] },
            "worktrees.sessionOwners": {
              sessions: [
                {
                  requestedKey: ownerKey,
                  key: ownerKey,
                  agentId: "main",
                  displayName: sessionName,
                },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}worktrees`);
        await page.locator('html[data-theme-mode="dark"]').waitFor({ state: "attached" });
        const surface = page.locator("openclaw-worktrees-page");
        const repository = surface.getByText("lobster", { exact: true });
        const branch = surface.getByText(branchName, { exact: true });
        const owner = surface.getByRole("link", { name: sessionName, exact: true });
        const updated = surface.locator(".worktrees-updated");
        const frame = await takeControlUiScreenshotFrame(page, surface, [branch, owner, updated], {
          animations: "disabled",
        });
        for (const item of [branch, owner]) {
          expect(await item.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
            true,
          );
        }
        expect(
          await repository.evaluate((element) => element.scrollWidth === element.clientWidth),
        ).toBe(true);
        expect(
          await updated.evaluate((element) => {
            const time = element.getBoundingClientRect();
            const row = element.parentElement!.getBoundingClientRect();
            return element.scrollWidth === element.clientWidth && time.right <= row.right + 1;
          }),
        ).toBe(true);
        await writeFile(path.join(suite.artifactDir, "after-narrow-dark.png"), frame.png);
      },
    );
  });
});
