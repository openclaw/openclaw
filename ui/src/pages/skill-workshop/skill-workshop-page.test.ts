import type { SkillsWorkshopListResult, SkillWorkshopChange } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { ApplicationContext } from "../../app/context.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import "./skill-workshop-page.ts";
import {
  createContext,
  createRuntimeConfigStub,
  type SkillWorkshopPageTestElement,
} from "./skill-workshop-page.test-support.ts";

const SKILL = "actual-budget-operations";
const VERSION = "20260929T010000000Z-patch";

const list: SkillsWorkshopListResult = {
  agentId: "research",
  mode: "auto",
  root: "/agents/research/workshop-skills",
  skills: [
    {
      name: SKILL,
      description: "Use when reconciling Actual Budget accounts",
      updatedAtMs: Date.now() - 60_000,
      sizeBytes: 900,
      files: ["SKILL.md"],
      useCount: 3,
    },
  ],
  archived: [
    {
      name: SKILL,
      live: true,
      versions: [{ id: VERSION, action: "patch", createdAtMs: Date.now() - 60_000 }],
    },
  ],
};

const change: SkillWorkshopChange = {
  id: "change-1",
  agentId: "research",
  skillName: SKILL,
  action: "patch",
  actor: "review",
  summary: "tightened reconciliation step",
  versionId: VERSION,
  createdAtMs: Date.now() - 60_000,
};

function workshopGateway(changes: SkillWorkshopChange[] = [change]) {
  return vi.fn(async (method: string) => {
    switch (method) {
      case "skills.workshop.list":
        return list;
      case "skills.workshop.changes":
        return { changes };
      case "skills.workshop.restore":
        return { change: { ...change, id: "change-2", action: "restore", actor: "user" } };
      case "skills.workshop.archive":
        return { change: { ...change, id: "change-3", action: "archive", actor: "user" } };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
}

async function mount(context: ApplicationContext) {
  const page = document.createElement(
    "openclaw-skill-workshop-page",
  ) as SkillWorkshopPageTestElement;
  page.context = context;
  document.body.append(page);
  await page.updateComplete;
  return page;
}

function button(page: HTMLElement, label: string) {
  return Array.from(page.querySelectorAll("button")).find(
    (entry) => entry.textContent?.trim() === label,
  );
}

afterEach(() => document.body.replaceChildren());

describe("Skill Workshop page", () => {
  it("shows a failed configuration read and retries only when requested", async () => {
    const firstRead = createDeferredCore<unknown>();
    const configRead = vi.fn().mockReturnValueOnce(firstRead.promise).mockResolvedValue({
      config: {},
      hash: "recovered",
      valid: true,
      issues: [],
    });
    const workshopRequest = workshopGateway();
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        return configRead();
      }
      if (method === "skills.workshop.read") {
        return Promise.resolve({
          name: SKILL,
          filePath: "SKILL.md",
          content: "Synthetic procedure",
          files: ["SKILL.md"],
        });
      }
      return workshopRequest(method);
    });
    const context = createContext(request, { methods: ["config.patch"] });
    const runtimeConfig = createRuntimeConfigCapability(context.gateway);
    Object.assign(context, { runtimeConfig });
    const page = await mount(context);
    try {
      const initialLoad = runtimeConfig.ensureLoaded();
      firstRead.reject(new Error("Configuration temporarily unavailable"));
      await initialLoad;
      await page.updateComplete;

      expect(configRead).toHaveBeenCalledOnce();
      expect(page.querySelector('[role="alert"]')?.textContent).toContain(
        "Configuration temporarily unavailable",
      );
      const retry = button(page, "Retry");
      expect(retry).toBeDefined();
      retry!.click();
      expect(configRead).toHaveBeenCalledTimes(2);
      await runtimeConfig.ensureLoaded();
      await page.updateComplete;

      expect(configRead).toHaveBeenCalledTimes(2);
      expect(runtimeConfig.state.configSnapshot?.hash).toBe("recovered");
      expect(page.textContent).not.toContain("Configuration temporarily unavailable");
      expect(button(page, "Auto")?.getAttribute("aria-pressed")).toBe("true");
    } finally {
      page.remove();
      runtimeConfig.dispose();
    }
  });

  it("lists learned skills and undoes a change by restoring its saved version", async () => {
    const request = workshopGateway();
    const page = await mount(
      createContext(request, {
        methods: ["skills.workshop.archive", "skills.workshop.restore"],
      }),
    );
    await vi.waitFor(() => {
      expect(page.textContent).toContain("Use when reconciling Actual Budget accounts");
      expect(page.textContent).toContain("tightened reconciliation step");
    });
    expect(request).toHaveBeenCalledWith("skills.workshop.list", { agentId: "research" });

    button(page, "Undo")?.click();

    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "skills.workshop.list"),
      ).toHaveLength(2),
    );
    expect(request).toHaveBeenCalledWith("skills.workshop.restore", {
      agentId: "research",
      name: SKILL,
      versionId: VERSION,
    });
  });

  it("undoes restoring an archived skill by archiving it again", async () => {
    const request = workshopGateway([
      { ...change, action: "restore", actor: "user", summary: "restored", versionId: undefined },
    ]);
    const page = await mount(
      createContext(request, {
        methods: ["skills.workshop.archive", "skills.workshop.restore"],
      }),
    );
    await vi.waitFor(() => expect(button(page, "Undo")).toBeDefined());

    button(page, "Undo")?.click();

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("skills.workshop.archive", {
        agentId: "research",
        name: SKILL,
      }),
    );
  });

  it("keeps a new agent's restore pending when the former agent's archive fails", async () => {
    const archive = createDeferredCore<unknown>();
    const restore = createDeferredCore<unknown>();
    const workshopRequest = workshopGateway();
    const request = vi.fn((method: string) => {
      if (method === "skills.workshop.archive") {
        return archive.promise;
      }
      if (method === "skills.workshop.restore") {
        return restore.promise;
      }
      if (method === "skills.workshop.read") {
        return Promise.resolve({
          name: SKILL,
          filePath: "SKILL.md",
          content: "Synthetic procedure",
          files: ["SKILL.md"],
        });
      }
      return workshopRequest(method);
    });
    const context = createContext(request, {
      methods: ["skills.workshop.archive", "skills.workshop.restore"],
    });
    const page = await mount(context);
    await vi.waitFor(() => expect(button(page, "Archive")).toBeDefined());
    button(page, "Archive")!.click();
    await page.updateComplete;

    Object.assign(context.agentSelection.state, { selectedId: "scout" });
    page.requestUpdate();
    await page.updateComplete;
    await vi.waitFor(() => expect(button(page, "Undo")).toBeDefined());
    const restoreButton = button(page, "Undo")!;
    restoreButton.click();
    await page.updateComplete;
    expect(restoreButton.disabled).toBe(true);

    archive.reject(new Error("Retired archive failed"));
    await archive.promise.catch(() => undefined);
    await page.updateComplete;
    expect(restoreButton.disabled).toBe(true);
    expect(page.textContent).not.toContain("Retired archive failed");

    restore.resolve({ change });
    await vi.waitFor(() => expect(button(page, "Undo")?.disabled).toBe(false));
    expect(request).toHaveBeenCalledWith("skills.workshop.restore", {
      agentId: "scout",
      name: SKILL,
      versionId: VERSION,
    });
  });

  it("offers no undo once the change's saved version has been pruned", async () => {
    const page = await mount(
      createContext(
        workshopGateway([
          { ...change, summary: "an older patch", versionId: "20260101T000000000Z-patch" },
        ]),
        { methods: ["skills.workshop.archive", "skills.workshop.restore"] },
      ),
    );
    await vi.waitFor(() => expect(page.textContent).toContain("an older patch"));
    expect(button(page, "Undo")).toBeUndefined();
  });

  it("opens the skill a chat notice links to, even when it is archived", async () => {
    const archivedVersion = "20260930T010000000Z-archive";
    const request = vi.fn(async (method: string) => {
      if (method === "skills.workshop.list") {
        return {
          ...list,
          archived: [
            ...list.archived,
            {
              name: "release-notes",
              live: false,
              versions: [{ id: archivedVersion, action: "archive", createdAtMs: Date.now() }],
            },
          ],
        };
      }
      return method === "skills.workshop.changes"
        ? { changes: [] }
        : { content: "", files: ["SKILL.md"] };
    });
    const page = await mount(createContext(request, { search: "?skill=release-notes" }));

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("skills.workshop.read", {
        agentId: "research",
        name: "release-notes",
        filePath: "SKILL.md",
        versionId: archivedVersion,
      }),
    );
    expect(request).not.toHaveBeenCalledWith(
      "skills.workshop.read",
      expect.objectContaining({ name: SKILL }),
    );
    // The Archived list is shown, so the linked skill is visible: sorting exists only on Active.
    await vi.waitFor(() => expect(page.querySelector(".sw-sort")).toBeNull());
  });

  it("offers no undo to an operator without admin scope", async () => {
    const page = await mount(
      createContext(workshopGateway(), {
        methods: ["skills.workshop.archive", "skills.workshop.restore"],
        scopes: ["operator.read"],
      }),
    );
    await vi.waitFor(() => expect(page.textContent).toContain("tightened reconciliation step"));
    expect(button(page, "Undo")).toBeUndefined();
  });

  it("compares a saved version's own metadata against today's", async () => {
    const skillFile = (description: string) =>
      `---\nname: ${SKILL}\ndescription: ${description}\n---\n\nSynthetic procedure`;
    const workshopRequest = workshopGateway();
    const request = vi.fn(async (method: string, params?: { versionId?: string }) =>
      method === "skills.workshop.read"
        ? {
            name: SKILL,
            filePath: "SKILL.md",
            content: skillFile(
              params?.versionId ? "Synthetic old summary" : list.skills[0]!.description,
            ),
            files: ["SKILL.md"],
          }
        : workshopRequest(method),
    );
    const page = await mount(createContext(request));
    await vi.waitFor(() => expect(page.textContent).toContain("Synthetic procedure"));

    page.querySelectorAll<HTMLButtonElement>(".sw-tab")[2]!.click();
    await page.updateComplete;
    button(page, "Compare")!.click();

    await vi.waitFor(() =>
      expect(page.querySelector(".sw-detail__desc")?.textContent).toBe("Synthetic old summary"),
    );
    const lines = Array.from(page.querySelectorAll(".sw-diff__line"), (line) => [
      line.classList.contains("sw-diff__line--remove")
        ? "-"
        : line.classList.contains("sw-diff__line--add")
          ? "+"
          : " ",
      line.querySelector(".sw-diff__text")?.textContent,
    ]);
    expect(lines).toContainEqual(["-", "description: Synthetic old summary"]);
    expect(lines).toContainEqual(["+", `description: ${list.skills[0]!.description}`]);
    expect(page.querySelector(".sw-diff__same")).toBeNull();
  });

  it("switches the learning mode through the config key", async () => {
    const runtimeConfig = createRuntimeConfigStub({
      sourceConfig: { skills: { workshop: { autonomous: { mode: "auto" } } } },
    });
    const page = await mount(
      createContext(workshopGateway(), { methods: ["config.patch"], runtimeConfig }),
    );
    expect(button(page, "Auto")?.getAttribute("aria-pressed")).toBe("true");

    button(page, "Off")?.click();

    await vi.waitFor(() => expect(runtimeConfig.refresh).toHaveBeenCalled());
    expect(runtimeConfig.patch).toHaveBeenCalledExactlyOnceWith({
      raw: { skills: { workshop: { autonomous: { mode: "off" } } } },
      note: "Disable Skill Workshop learning",
    });
  });
});
