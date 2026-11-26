// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
