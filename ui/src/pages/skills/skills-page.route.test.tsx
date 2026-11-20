// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dynamicRouteFromPath,
  pathForClawHubSkill,
  pathForInstalledSkill,
  skillPageFromPath,
} from "../../app-route-paths.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { canonicalSkillsRouteLocation } from "./route-location.ts";
import { mountSkills, personalLibrary } from "./skills-page.test-support.tsx";
import { createReport, createSkill } from "./view.test-support.ts";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Skill page addresses", () => {
  it("names installed and ClawHub skills by paths that read back", () => {
    expect(pathForInstalledSkill("repo-skill", "discovery")).toBe("/skills/installed/repo-skill");
    expect(pathForInstalledSkill("repo.skill", "settings", "/ui")).toBe(
      "/ui/settings/skills/repo%2Eskill",
    );
    expect(pathForClawHubSkill("@steipete/gog")).toBe("/skills/clawhub/@steipete/gog");
    expect(skillPageFromPath("/ui/settings/skills/repo%2Eskill", "/ui")).toEqual({
      kind: "installed",
      skillKey: "repo.skill",
    });
    expect(skillPageFromPath("/skills/clawhub/@steipete/gog")).toEqual({
      kind: "clawhub",
      ref: "@steipete/gog",
    });
    expect(dynamicRouteFromPath("/ui/skills/installed", "/ui")?.[0]).toBe("skills");
    expect(skillPageFromPath("/skills/installed")).toBeNull();
    // The workshop keeps its own address.
    expect(skillPageFromPath("/skills/workshop")).toBeNull();
    expect(skillPageFromPath("/skills/installed/..")).toBeNull();
  });

  it("opens older ClawHub links on the skill's page", () => {
    expect(
      canonicalSkillsRouteLocation({
        pathname: "/skills",
        search: "?clawhub=%40steipete%2Fgog&agent=main",
        hash: "",
      }),
    ).toEqual({ pathname: "/skills/clawhub/@steipete/gog", search: "?agent=main", hash: "" });
    expect(
      canonicalSkillsRouteLocation({ pathname: "/skills", search: "?agent=main", hash: "" }),
    ).toBeNull();
  });
});

describe("Installed skill page route", () => {
  it("returns from a skill to the same installed inventory and filter", async () => {
    const report = createReport([
      createSkill(),
      createSkill({ name: "Calendar", skillKey: "calendar" }),
    ]);
    const request = vi.fn(async (method: string) => {
      if (method === "skills.status") return report;
      if (method === "skills.library.list") return personalLibrary;
      if (method === "skills.search") return { results: [] };
      throw new Error("Unexpected method: " + method);
    });
    const { page, context, publishRouteData } = mountSkills(request, "discovery");
    publishRouteData({ report });
    await waitForFast(() => expect(page.querySelector(".skill-installed-shelf")).not.toBeNull());
    page.querySelector<HTMLButtonElement>(".skill-installed-shelf")!.click();
    expect(context.navigate).toHaveBeenLastCalledWith("skills", {
      pathname: "/skills/installed",
      search: "",
    });
    await waitForFast(() =>
      expect(page.querySelector(".skill-installed-heading h1")?.textContent).toBe(
        "Installed skills",
      ),
    );
    const filter = page.querySelector<HTMLInputElement>('input[name="installed-skills-search"]')!;
    filter.value = "repo";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    await waitForFast(() =>
      expect(page.querySelector('[data-skill-id="local:calendar"]')).toBeNull(),
    );
    const row = page.querySelector<HTMLButtonElement>('[data-skill-id="local:repo-skill"] button')!;
    row.click();
    await waitForFast(() =>
      expect(page.querySelector(".skill-page h1")?.textContent).toBe("Repo Skill"),
    );
    const back = page.querySelector<HTMLAnchorElement>(
      ".skill-page .plugins-settings-breadcrumb__parent",
    )!;
    expect(back.textContent).toBe("Installed skills");
    back.click();
    await waitForFast(() => expect(page.querySelector(".skill-page")).toBeNull());
    expect(context.navigate).toHaveBeenLastCalledWith("skills", {
      pathname: "/skills/installed",
      search: "",
    });
    expect(filter.value).toBe("repo");
    expect(page.querySelector('[data-skill-id="local:repo-skill"] button')).toBe(row);
  });

  function inventory() {
    const report = createReport([createSkill()]);
    const request = vi.fn(async (method: string) => {
      if (method === "skills.status") {
        return report;
      }
      if (method === "skills.library.list") {
        return { ...personalLibrary, defaultTarget: "workspace" };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const mounted = mountSkills(request, "settings");
    mounted.publishRouteData({ report });
    return mounted;
  }

  it.each(["", "?agent=main"])(
    "keeps the list and its agent search %s when opening a skill and going back",
    async (search) => {
      const mounted = inventory();
      await mounted.router.navigate(
        "skill-settings",
        mounted.context,
        {},
        { pathname: "/settings/skills", search, hash: "" },
      );
      await waitForFast(() =>
        expect(mounted.page.querySelector(".plugins-item__detail-button")).not.toBeNull(),
      );
      mounted.page.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
      expect(mounted.context.navigate).toHaveBeenLastCalledWith("skill-settings", {
        pathname: "/settings/skills/repo-skill",
        search,
      });
      await waitForFast(() =>
        expect(mounted.page.querySelector(".skill-page h1")?.textContent).toBe("Repo Skill"),
      );
      const list = mounted.page.querySelector<HTMLElement>(".skills-list-surface")!;
      expect(list.hidden).toBe(true);
      const row = mounted.page.querySelector(".plugins-item");

      mounted.page
        .querySelector<HTMLAnchorElement>(".plugins-settings-breadcrumb__parent")!
        .click();
      expect(mounted.context.navigate).toHaveBeenLastCalledWith("skill-settings", {
        search,
      });
      await waitForFast(() => expect(mounted.page.querySelector(".skill-page")).toBeNull());
      expect(list.hidden).toBe(false);
      // The same list comes back, not a reloaded one.
      expect(mounted.page.querySelector(".plugins-item")).toBe(row);
    },
  );

  it("shows a skill that is not installed as not found, with the way back", async () => {
    const mounted = inventory();
    await waitForFast(() =>
      expect(mounted.page.querySelector(".plugins-item__detail-button")).not.toBeNull(),
    );
    await mounted.router.navigate(
      "skill-settings",
      mounted.context,
      {},
      { pathname: "/settings/skills/missing-skill", search: "", hash: "" },
    );
    await waitForFast(() =>
      expect(mounted.page.querySelector(".skill-page__absent")?.textContent).toContain(
        "Skill not found.",
      ),
    );
    expect(
      mounted.page.querySelector(".skill-page .plugins-settings-breadcrumb__current")?.textContent,
    ).toBe("missing-skill");
    expect(
      mounted.page.querySelector(".skill-page .plugins-settings-breadcrumb__parent")?.textContent,
    ).toBe("Skills");
  });
});
