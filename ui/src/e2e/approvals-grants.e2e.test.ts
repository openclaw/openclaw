import path from "node:path";
import { expect, it } from "vitest";
import type { ExecApprovalStandingGrant } from "../../../packages/gateway-protocol/src/schema/exec-approvals.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Standing grants independent of approval history",
  startServerBeforeBrowser: true,
});
const grant: ExecApprovalStandingGrant = {
  grantId: "grant-independent",
  mintedByApprovalId: "approval-independent",
  agentId: "main",
  cronJobId: "job-independent",
  cronJobName: "Synthetic daily report",
  command: "echo synthetic-report",
  cwd: null,
  createdAtMs: 1_000,
  expiresAtMs: null,
  revokedAtMs: null,
  revokedBy: null,
  lastUsedAtMs: null,
  useCount: 3,
};
suite.define(() => {
  it.each([390, 1200])("keeps history still when empty grants arrive at %ipx", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 900 }, locale: "en-US", reducedMotion: "reduce" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          deferredMethods: ["exec.approval.grants.list"],
          methodResponses: {
            "exec.approval.grants.list": { grants: [] },
            "approval.history": {
              items: [
                {
                  id: "approval-resolved",
                  status: "denied",
                  presentation: {
                    kind: "exec",
                    commandText: "echo synthetic-history",
                    allowedDecisions: ["deny"],
                  },
                  urlPath: "/approve/approval-resolved",
                  createdAtMs: 1_000,
                  expiresAtMs: 61_000,
                  resolvedAtMs: 2_000,
                  decision: "deny",
                  reason: "user",
                  source: { agentId: "main", sessionKey: "agent:main:synthetic" },
                  resolver: { kind: "device", id: "synthetic-device" },
                },
              ],
            },
          },
        });
        await page.goto(new URL("settings/approvals", suite.server.baseUrl).href);
        await gateway.waitForRequest("exec.approval.grants.list");
        const grants = page.locator(".settings-section").filter({
          has: page.getByRole("heading", { name: "Standing grants", exact: true }),
        });
        const history = page.locator(".settings-section").filter({
          has: page.getByRole("heading", { name: "Approval history", exact: true }),
        });
        const log = history.getByRole("list", { name: "Approval history" });
        await log.getByText("echo synthetic-history", { exact: true }).waitFor();
        await grants.getByText("Unknown", { exact: true }).waitFor();
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const top = () => history.evaluate((section) => section.getBoundingClientRect().top);
        const initialTop = await top();
        const initialLogTop = await log.evaluate((list) => list.getBoundingClientRect().top);
        await gateway.resolveDeferred("exec.approval.grants.list");
        await grants
          .getByText(
            "No standing grants yet. Choose Always allow on an automation approval to create one.",
            { exact: true },
          )
          .waitFor();
        expect(await top()).toBe(initialTop);
        expect(await log.evaluate((list) => list.getBoundingClientRect().top)).toBe(initialLogTop);
      },
    );
  });

  it.each([320, 390, 820, 1100, 1440])("shows grants as rows at %ipx", async (width) => {
    const command = `tar -czf /var/backups/${"workspace-".repeat(12)}.tgz ./workspace`;
    await suite.withPage(
      { viewport: { width, height: 900 }, locale: "en-US", reducedMotion: "reduce" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "approval.history": { items: [] },
            "exec.approval.grants.list": {
              grants: [
                { ...grant, command },
                { ...grant, grantId: "grant-revoked", revokedAtMs: 2_000, revokedBy: "operator" },
                { ...grant, grantId: "grant-expired", expiresAtMs: 2_000 },
              ],
            },
            "exec.approval.grants.revoke": { outcome: "revoked" },
          },
        });
        await page.goto(new URL("settings/approvals", suite.server.baseUrl).href);
        const grants = page.getByRole("list", { name: "Standing grants" });
        for (const state of ["Until revoked", "Revoked", "Expired"]) {
          await grants.getByText(state, { exact: true }).waitFor();
        }
        await grants.getByText(command, { exact: true }).waitFor();
        expect(await grants.evaluate((list) => list.scrollWidth - list.clientWidth)).toBe(0);
        const revoke = grants.getByRole("button", { name: /Revoke/ });
        const [row, button] = await Promise.all([
          grants.getByRole("listitem").first().boundingBox(),
          revoke.boundingBox(),
        ]);
        expect(button!.x + button!.width).toBeGreaterThan(row!.x + row!.width - 24);
        await revoke.click();
        await expect.poll(() => gateway.getRequests("exec.approval.grants.revoke")).toHaveLength(1);
        await expect.poll(() => grants.getByRole("button").count()).toBe(0);
      },
    );
  });

  it.each([320, 390, 820, 1100, 1440])("keeps the history log even at %ipx", async (width) => {
    const sessionKey = `agent:main:telegram:group:${"release-coordination-".repeat(6)}review`;
    const commandText = `pnpm --filter ./packages/${"synthetic-long-package-".repeat(6)} run build`;
    const record = (id: string, fields: object) => ({
      id,
      presentation: { kind: "exec", commandText, allowedDecisions: ["allow-once", "deny"] },
      urlPath: `/approve/${id}`,
      createdAtMs: 1_000,
      expiresAtMs: 61_000,
      resolvedAtMs: 2_000,
      source: { agentId: "main", sessionKey },
      resolver: { kind: "device", id: "reviewer-device" },
      ...fields,
    });
    await suite.withPage(
      { viewport: { width, height: 900 }, locale: "en-US", reducedMotion: "reduce" },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "approval.history": {
              items: [
                record("a", { status: "allowed", decision: "allow-always", reason: "user" }),
                record("o", { status: "allowed", decision: "allow-once", reason: "user" }),
                record("d", { status: "denied", decision: "deny", reason: "user" }),
                record("e", { status: "expired", reason: "timeout" }),
                record("c", { status: "cancelled", reason: "run-aborted" }),
              ],
            },
            "exec.approval.grants.list": { grants: [grant] },
          },
        });
        await page.goto(new URL("settings/approvals", suite.server.baseUrl).href);
        const log = page.getByRole("list", { name: "Approval history" });
        const rows = log.getByRole("listitem");
        await expect.poll(() => rows.count()).toBe(5);
        for (const status of ["Allowed · Always allow", "Allowed · Allow once", "Denied"]) {
          await log.locator(".settings-status").getByText(status, { exact: true }).waitFor();
        }
        const heights = () =>
          rows.evaluateAll((items) => items.map((row) => row.getBoundingClientRect().height));
        const collapsed = await heights();
        expect(new Set(collapsed).size).toBe(1);
        expect(collapsed[0]).toBeLessThan(68);
        // The longest status and its time keep to one line, without clipping the status.
        const clipped = await log.evaluate((list) =>
          [...list.querySelectorAll(".settings-status > :last-child")].some(
            (label) => label.scrollWidth > label.clientWidth,
          ),
        );
        expect(clipped).toBe(false);

        const second = rows.nth(1);
        const footnoteAligned = await page.evaluate(() => {
          const info = document.querySelector(".data-table-pagination__info")!;
          const request = document.querySelector(".approval-log__request")!;
          return (
            getComputedStyle(info).textAlign === "start" &&
            Math.abs(info.getBoundingClientRect().left - request.getBoundingClientRect().left) < 1
          );
        });
        expect(footnoteAligned).toBe(true);
        const firstTop = await rows.first().evaluate((row) => row.getBoundingClientRect().top);
        await rows.first().getByRole("button").click();
        await expect
          .poll(() => rows.first().getByRole("button").getAttribute("aria-expanded"))
          .toBe("true");
        await rows.first().getByText(sessionKey, { exact: true }).waitFor();
        expect(await rows.first().evaluate((row) => row.getBoundingClientRect().top)).toBe(
          firstTop,
        );
        expect((await heights()).slice(1)).toEqual(collapsed.slice(1));
        expect(await second.locator("dl").count()).toBe(0);
        await rows.last().getByRole("button").click();
        await rows.last().locator("dd").first().waitFor();
        const valueAxes = await log.evaluate((list) => [
          ...new Set(
            [...list.querySelectorAll("dd")].map((value) => value.getBoundingClientRect().left),
          ),
        ]);
        expect(valueAxes).toHaveLength(1);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
        ).toBeLessThanOrEqual(0);
        expect(await log.evaluate((list) => list.scrollWidth - list.clientWidth)).toBe(0);
      },
    );
  });

  it("keeps standing grants revocable when history fails", async () => {
    await suite.withPage(
      { viewport: { width: 1200, height: 900 }, locale: "en-US", reducedMotion: "reduce" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          deferredMethods: ["approval.history"],
          methodResponses: {
            "exec.approval.grants.list": { grants: [grant] },
            "exec.approval.grants.revoke": { outcome: "revoked" },
          },
        });
        await page.goto(new URL("settings/approvals", suite.server.baseUrl).href);
        await gateway.waitForRequest("approval.history");
        await gateway.rejectDeferred("approval.history", {
          code: "UNAVAILABLE",
          message: "Synthetic history unavailable",
        });
        await page
          .getByRole("alert")
          .filter({ hasText: "Synthetic history unavailable" })
          .waitFor();
        await page.screenshot({
          path: path.join(suite.artifactDir, "ui-operations-oct25-afternoon-history-failed.png"),
          animations: "disabled",
        });
        await expect.poll(() => gateway.getRequests("exec.approval.grants.list")).toHaveLength(1);
        const grants = page.getByRole("list", { name: "Standing grants" });
        await grants.getByText(grant.cronJobName!, { exact: true }).waitFor();
        await grants.getByRole("button", { name: /Revoke/ }).click();
        await expect.poll(() => gateway.getRequests("exec.approval.grants.revoke")).toHaveLength(1);
        expect((await gateway.getRequests("exec.approval.grants.revoke"))[0]?.params).toEqual({
          grantId: grant.grantId,
        });
        await grants.getByText("Revoked", { exact: true }).waitFor();
        await expect.poll(() => grants.getByRole("button").count()).toBe(0);
      },
    );
  });
});
