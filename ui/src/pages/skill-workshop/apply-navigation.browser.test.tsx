import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { createContext, createRuntimeConfigStub } from "./skill-workshop-page.test-support.ts";
import { SkillWorkshopPage } from "./skill-workshop-page.tsx";

it("keeps the applied skill open when an earlier Retry returns its old draft list", async () => {
  const plum = { id: "plum-draft", skillName: "plum-notes", summary: "Plum draft", createdAtMs: 1 };
  const berry = {
    id: "berry-draft",
    skillName: "berry-notes",
    summary: "Berry draft",
    createdAtMs: 2,
  };
  const saved = {
    name: plum.skillName,
    live: false,
    versions: [{ id: "plum-archived", action: "archive", createdAtMs: 1 }],
  };
  const original = {
    agentId: "research",
    mode: "propose",
    root: "/synthetic/workshop",
    skills: [],
    archived: [saved],
    drafts: [plum, berry],
  };
  const applied = {
    ...original,
    archived: [{ ...saved, live: true }],
    skills: [
      {
        name: plum.skillName,
        description: "Orchard notes",
        files: ["SKILL.md"],
        sizeBytes: 12,
        updatedAtMs: 3,
      },
    ],
    drafts: [berry],
  };
  const retry = createDeferredCore<typeof original>();
  const list = vi
    .fn()
    .mockResolvedValueOnce(original)
    .mockReturnValueOnce(retry.promise)
    .mockResolvedValue(applied);
  const request = vi.fn((method: string, params: { draftId?: string }) => {
    switch (method) {
      case "skills.workshop.list":
        return list();
      case "skills.workshop.changes":
      case "skills.workshop.applyDraft":
        return Promise.resolve({ changes: [] });
      case "skills.workshop.read":
        return Promise.resolve({
          content: params.draftId ? "Draft instructions" : "Water the plum trees.",
          files: ["SKILL.md"],
        });
      default:
        throw new Error(`Unexpected method: ${method}`);
    }
  });
  const runtimeConfig = createRuntimeConfigStub();
  runtimeConfig.state.lastError = "Configuration unavailable";
  const context = createContext(request, {
    methods: ["skills.workshop.applyDraft", "skills.workshop.archive", "skills.workshop.restore"],
    runtimeConfig,
    search: `?draft=${plum.id}`,
  });
  mountSolid(() => <SkillWorkshopPage />, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });

  await expect.element(page.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Retry" }).click();
  expect(list).toHaveBeenCalledTimes(2);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  const instructions = page.getByText("Water the plum trees.", { exact: true });
  const description = page.getByText("Orchard notes", { exact: true });
  await expect.element(instructions).toBeVisible();
  await expect.element(description).toBeVisible();
  expect(context.router.getState().location.search).toBe("?skill=plum-notes");

  const archive = page.getByRole("button", { name: "Archive", exact: true });
  const restore = page.getByRole("button", { name: "Restore", exact: true });
  await expect.element(archive).toBeEnabled();

  retry.resolve(original);
  // The older inventory has arrived when the live skill's list description disappears.
  await expect.element(description).not.toBeInTheDocument();
  await expect.element(restore).not.toBeInTheDocument();
  expect(context.router.getState().location.search).toBe("?skill=plum-notes");
  await expect.element(instructions).toBeVisible();

  await page.getByRole("button", { name: "Retry" }).click();
  await expect.element(description).toBeVisible();
  await expect.element(archive).toBeEnabled();
  expect(context.router.getState().location.search).toBe("?skill=plum-notes");
});
