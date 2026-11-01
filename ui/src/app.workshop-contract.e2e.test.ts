import type { SkillsWorkshopListResult, SkillWorkshopChange } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./e2e/control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "./test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({ name: "Workshop public UI contract" });
const skillName = "deploy-staging";
const archivedName = "release-notes";
const versionId = "20261015T010000000Z-patch";
const archivedVersionId = "20261015T020000000Z-archive";
const runId = "skill-workshop-review:11111111-1111-4111-8111-111111111111";
const sessionKey = "agent:main:main";
const timestamp = Date.now();
const list: SkillsWorkshopListResult = {
  agentId: "main",
  mode: "auto",
  root: "/synthetic/agents/main/workshop-skills",
  skills: [
    {
      name: skillName,
      description: "Current deployment procedure",
      updatedAtMs: timestamp,
      sizeBytes: 200,
      files: ["SKILL.md"],
      useCount: 7,
    },
  ],
  archived: [
    {
      name: skillName,
      live: true,
      versions: [{ id: versionId, action: "patch", createdAtMs: timestamp }],
    },
    {
      name: archivedName,
      live: false,
      versions: [{ id: archivedVersionId, action: "archive", createdAtMs: timestamp }],
    },
  ],
};
const changes: SkillWorkshopChange[] = [
  {
    id: "retained-change",
    agentId: "main",
    skillName,
    action: "patch",
    actor: "review",
    summary: "Retained rollback improvement",
    versionId,
    createdAtMs: timestamp,
  },
  {
    id: "pruned-change",
    agentId: "main",
    skillName,
    action: "patch",
    actor: "review",
    summary: "Older pruned improvement",
    versionId: "20260101T000000000Z-patch",
    createdAtMs: timestamp - 1000,
  },
];
const config = { skills: { workshop: { autonomous: { mode: "auto" } } } };
const methodResponses = {
  "agents.list": {
    agents: [
      { id: "main", name: "Main" },
      { id: "research", name: "Research" },
    ],
    defaultId: "main",
    mainKey: "main",
    scope: "agent",
  },
  "config.get": {
    config,
    sourceConfig: config,
    hash: "workshop-contract-config",
    valid: true,
    issues: [],
    raw: JSON.stringify(config),
  },
  "config.patch": { ok: true, config },
  "skills.workshop.list": {
    cases: [
      { match: { agentId: "research" }, response: { ...list, agentId: "research" } },
      { response: list },
    ],
  },
  "skills.workshop.changes": { changes },
  "skills.workshop.read": {
    cases: [
      {
        match: { name: archivedName },
        response: {
          name: archivedName,
          filePath: "SKILL.md",
          files: ["SKILL.md"],
          content:
            "---\nname: release-notes\ndescription: Archived release checklist\n---\n\nPreserved release instructions.",
        },
      },
      {
        match: { versionId },
        response: {
          name: skillName,
          filePath: "SKILL.md",
          files: ["SKILL.md"],
          content:
            "---\nname: deploy-staging\ndescription: Old deployment procedure\n---\n\nDeploy safely.",
        },
      },
      {
        response: {
          name: skillName,
          filePath: "SKILL.md",
          files: ["SKILL.md"],
          content:
            "---\nname: deploy-staging\ndescription: Current deployment procedure\n---\n\nDeploy safely.",
        },
      },
    ],
  },
  "skills.workshop.undo": { status: "undone", changes: [] },
  "skills.workshop.restore": {
    change: { ...changes[0], id: "restore-change", action: "restore", actor: "user" },
  },
};
const featureMethods = [...Object.keys(methodResponses), "skills.workshop.archive"];

// Persisted transcript shape, deliberately not constructed by Workshop code.
const historyMessages = [
  { role: "user", content: "Deploy the staging service", timestamp: timestamp - 2000 },
  { role: "assistant", content: "Deployment complete.", timestamp: timestamp - 1000 },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: '💾 Learned: updated `deploy-staging`; created `release-notes`. Say "undo" to revert this skill change.',
      },
    ],
    provider: "openclaw",
    model: "delivery-mirror",
    timestamp,
    openclawDeliveryMirror: {
      kind: "skill-workshop-change",
      agentId: "research",
      runId,
      skills: [
        { name: skillName, action: "updated", summary: "tightened rollback" },
        { name: archivedName, action: "created" },
      ],
    },
    __openclaw: { id: "persisted-workshop-notice", seq: 3 },
  },
];

async function openWorkshop(
  page: Page,
  operatorScopes = ["operator.admin"],
  overrides: Record<string, unknown> = {},
) {
  const gateway = await installMockGateway(page, {
    featureMethods: [...new Set([...featureMethods, ...Object.keys(overrides)])],
    methodResponses: { ...methodResponses, ...overrides },
    operatorScopes,
  });
  await page.goto(`${suite.server.baseUrl}skills/workshop`);
  await waitForControlUiRoute(page, { pathname: "/skills/workshop", routeId: "skill-workshop" });
  await page.locator(".sw-row").filter({ hasText: skillName }).waitFor();
  return gateway;
}

suite.define(() => {
  it("renders persisted history markers, retains failed Undo, and opens the notice agent's archived skill", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods,
        methodResponses,
        historyMessages,
        sessionKey,
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const notice = page.getByRole("group", { name: "Learned", exact: true });
      await expect.poll(() => notice.textContent()).toContain("Updateddeploy-staging");
      expect(await notice.textContent()).toContain("Createdrelease-notes");
      expect(await notice.getByRole("button", { name: /tightened rollback/ }).count()).toBe(1);
      expect(await page.getByText("Deployment complete.", { exact: true }).count()).toBe(1);
      await gateway.deferNext("skills.workshop.undo");
      await notice.getByRole("button", { name: "Undo", exact: true }).click();
      const undo = await gateway.waitForRequest("skills.workshop.undo");
      expect(undo.params).toEqual({ agentId: "research", runId });
      await gateway.rejectDeferred("skills.workshop.undo", {
        code: "INVALID_REQUEST",
        message: "Saved version has been pruned.",
      });
      await expect
        .poll(() => notice.getByRole("alert").textContent())
        .toContain("Saved version has been pruned.");
      expect(await notice.getByRole("button", { name: "Undo", exact: true }).isEnabled()).toBe(
        true,
      );
      await notice.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(() => notice.getByRole("status").textContent()).toContain("Undone");
      expect(await gateway.getRequests("skills.workshop.undo")).toHaveLength(2);
      expect(await notice.getByRole("button", { name: "Undo", exact: true }).count()).toBe(0);
      await notice.getByRole("button", { name: /Created release-notes/ }).click();
      await waitForControlUiRoute(page, {
        pathname: "/skills/workshop",
        routeId: "skill-workshop",
      });
      expect(new URL(page.url()).searchParams.get("skill")).toBe(archivedName);
      const read = await gateway.waitForRequest("skills.workshop.read", {
        match: { name: archivedName },
      });
      expect(read.params).toEqual({
        agentId: "research",
        name: archivedName,
        filePath: "SKILL.md",
        versionId: archivedVersionId,
      });
      await expect
        .poll(() => page.locator(".sw-detail").textContent())
        .toContain("Preserved release instructions.");
    });
  });

  it("renders the Learned row from history without offering Undo to read-only operators", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods,
        methodResponses,
        historyMessages,
        sessionKey,
        operatorScopes: ["operator.read"],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const notice = page.getByRole("group", { name: "Learned", exact: true });
      await notice.waitFor();
      expect(await notice.getByRole("button", { name: /deploy-staging/ }).count()).toBe(1);
      expect(await notice.getByRole("button", { name: "Undo", exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("skills.workshop.undo")).toHaveLength(0);
    });
  });

  it("routes to the library, shows retained versus pruned change actions and metadata diffs, and writes learning mode", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await openWorkshop(page);
      const liveRow = page.locator(".sw-row").filter({ hasText: skillName });
      expect(await liveRow.textContent()).toContain("7 uses");
      await liveRow.locator(".sw-row__main").click();
      await page
        .locator(".sw-tabs")
        .getByRole("button", { name: /History/ })
        .click();
      const retained = page
        .locator(".sw-timeline__item")
        .filter({ hasText: "Retained rollback improvement" });
      const pruned = page
        .locator(".sw-timeline__item")
        .filter({ hasText: "Older pruned improvement" });
      await retained.waitFor();
      expect(await retained.getByRole("button", { name: "Undo", exact: true }).count()).toBe(1);
      expect(await pruned.getByRole("button").count()).toBe(0);
      await retained.getByRole("button", { name: "Undo", exact: true }).click();
      expect((await gateway.waitForRequest("skills.workshop.restore")).params).toEqual({
        agentId: "main",
        name: skillName,
        versionId,
      });
      await retained.getByRole("button", { name: "Compare", exact: true }).click();
      await expect
        .poll(() => page.locator(".sw-detail__desc").textContent())
        .toBe("Old deployment procedure");
      expect(await page.locator(".sw-diff__line--remove").textContent()).toContain(
        "description: Old deployment procedure",
      );
      expect(await page.locator(".sw-diff__line--add").textContent()).toContain(
        "description: Current deployment procedure",
      );
      await page.getByRole("button", { name: "Off", exact: true }).click();
      const patch = await gateway.waitForRequest("config.patch");
      expect(patch.params).toMatchObject({
        raw: JSON.stringify({ skills: { workshop: { autonomous: { mode: "off" } } } }),
        baseHash: "workshop-contract-config",
        note: "Disable Skill Workshop learning",
      });
      await page.getByRole("button", { name: /^Archived/ }).click();
      await page.locator(".sw-row").filter({ hasText: archivedName }).waitFor();
      expect(await page.locator(".sw-row").filter({ hasText: skillName }).count()).toBe(0);
    });
  });

  it("reviews waiting drafts as a diff against the live skill and applies or discards them", async () => {
    await suite.withPage({}, async ({ page }) => {
      const drafted = (id: string, summary: string) => ({
        id,
        skillName,
        summary,
        createdAtMs: timestamp,
      });
      const gateway = await openWorkshop(page, ["operator.admin"], {
        "skills.workshop.list": {
          ...list,
          mode: "propose",
          drafts: [
            drafted("deploy-staging-1a2b3c4d", "Check the rollback first"),
            drafted("deploy-staging-5e6f7a8b", "Unused idea"),
          ],
        },
        "skills.workshop.read": {
          cases: [
            {
              match: { draftId: "deploy-staging-1a2b3c4d" },
              response: {
                name: skillName,
                filePath: "SKILL.md",
                files: ["SKILL.md"],
                content:
                  "---\nname: deploy-staging\ndescription: Current deployment procedure\n---\n\nCheck the rollback first.",
              },
            },
            ...methodResponses["skills.workshop.read"].cases,
          ],
        },
        "skills.workshop.applyDraft": { changes: [] },
        "skills.workshop.discardDraft": { changes: [] },
      });
      await page.getByRole("button", { name: /^Drafts/ }).click();
      const first = page.locator(".sw-row").filter({ hasText: "Check the rollback first" });
      await first.locator(".sw-row__main").click();
      await expect
        .poll(() => page.locator(".sw-diff__line--add").allTextContents())
        .toContainEqual(expect.stringContaining("Check the rollback first."));
      expect(await page.locator(".sw-diff__key--remove").textContent()).toBe("Live skill");
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      expect((await gateway.waitForRequest("skills.workshop.applyDraft")).params).toEqual({
        agentId: "main",
        name: skillName,
        draftId: "deploy-staging-1a2b3c4d",
      });
      await page.getByRole("button", { name: /^Drafts/ }).click();
      await page
        .locator(".sw-row")
        .filter({ hasText: "Unused idea" })
        .locator(".sw-row__main")
        .click();
      await page.getByRole("button", { name: "Discard", exact: true }).click();
      expect((await gateway.waitForRequest("skills.workshop.discardDraft")).params).toEqual({
        agentId: "main",
        name: skillName,
        draftId: "deploy-staging-5e6f7a8b",
      });
    });
  });

  it("opens archived deep links read-only with no archive, restore or undo controls", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods,
        methodResponses,
        operatorScopes: ["operator.read"],
      });
      await page.goto(`${suite.server.baseUrl}skills/workshop?skill=${archivedName}`);
      await waitForControlUiRoute(page, {
        pathname: "/skills/workshop",
        routeId: "skill-workshop",
      });
      await expect
        .poll(() => page.locator(".sw-detail").textContent())
        .toContain("Preserved release instructions.");
      expect((await gateway.waitForRequest("skills.workshop.read")).params).toEqual({
        agentId: "main",
        name: archivedName,
        filePath: "SKILL.md",
        versionId: archivedVersionId,
      });
      const workshop = page.locator("openclaw-skill-workshop-page");
      expect(await workshop.getByRole("button", { name: /^(Archive|Restore|Undo)$/ }).count()).toBe(
        0,
      );
      expect(await workshop.getByRole("button", { name: "Off", exact: true }).isDisabled()).toBe(
        true,
      );
      expect(await workshop.getByRole("button", { name: "Auto", exact: true }).isDisabled()).toBe(
        true,
      );
      await page.getByRole("button", { name: /^Active/ }).click();
      await page.locator(".sw-row__main").filter({ hasText: skillName }).click();
      await page
        .locator(".sw-tabs")
        .getByRole("button", { name: /History/ })
        .click();
      await page
        .locator(".sw-timeline")
        .getByText("Retained rollback improvement", { exact: true })
        .waitFor();
      expect(await workshop.getByRole("button", { name: /^(Archive|Restore|Undo)$/ }).count()).toBe(
        0,
      );
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      expect(await gateway.getRequests("skills.workshop.restore")).toHaveLength(0);
    });
  });
});
