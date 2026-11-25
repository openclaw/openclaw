import { afterEach, describe, expect, it } from "vitest";
import "../../styles.css";
import { cleanupSkillsViews, renderSkills } from "./view.solid.test-support.tsx";
import { createProps, createReport, createSkill } from "./view.test-support.ts";

const browserMode = "__vitest_browser__" in globalThis;
let container: HTMLElement | undefined;

afterEach(() => {
  cleanupSkillsViews();
  container?.remove();
});

function createContainer() {
  container?.remove();
  container = document.createElement("openclaw-skills-page");
  document.body.append(container);
}

function showInstalled(skill: Parameters<typeof createSkill>[0], messages = {}) {
  renderSkills(
    createProps({ detailKey: "repo-skill", report: createReport([createSkill(skill)]), messages }),
    container!,
  );
}

async function renderedPage() {
  await expect
    .poll(() => container!.querySelector(".skill-page h1, .skill-page__absent"))
    .not.toBeNull();
  return container!
    .querySelector<HTMLElement>(".skill-page h1, .skill-page__absent")!
    .closest<HTMLElement>(".skill-page")!;
}

const query = (selector: string, parent = container!) =>
  parent.querySelector<HTMLElement>(selector)!;

describe.runIf(browserMode)("skill page layout", () => {
  it.each([390, 1440])(
    "keeps requirement actions on their rows and the switch in the header at %ipx",
    async (width) => {
      const { page } = await import("vitest/browser");
      await page.viewport(width, 844);
      createContainer();
      showInstalled(
        {
          description: "Read the workspace guide and preserve current permissions. ".repeat(20),
          missing: { bins: [], anyBins: ["guide-cli"], env: [], config: [], os: [] },
          install: [
            {
              id: "guide-cli",
              kind: "node",
              bins: ["guide-cli"],
              label: "Install the missing workspace guide command-line dependency",
            },
          ],
        },
        { "repo-skill": { kind: "error", message: "A previous install needs attention." } },
      );
      const skillPage = await renderedPage();
      const hero = query(".plugin-catalog-detail__hero", skillPage);
      const main = query(".plugin-catalog-detail__main", skillPage);
      const facts = query(".plugin-catalog-detail__sidebar", skillPage);
      expect(query(".skills-list-surface").hidden).toBe(true);
      expect(hero.querySelector('input[role="switch"]')).not.toBeNull();
      expect(main.querySelector("input[type=password]")).not.toBeNull();
      expect(main.querySelector("[role=alert]")?.textContent).toContain("needs attention");
      expect(facts.textContent).toContain("/tmp/skill");
      const install = query(".skill-requirement__control > .btn", main) as HTMLButtonElement;
      expect(install.textContent).toContain("workspace guide");
      const save = query(".skill-requirement__key .btn", main) as HTMLButtonElement;
      for (const button of [install, save]) {
        expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
        expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(
          main.getBoundingClientRect().right + 1,
        );
      }
      // One column on a phone: the facts close the page; beside the reading column otherwise.
      if (width < 768) {
        expect(facts.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          main.getBoundingClientRect().bottom,
        );
      } else {
        expect(facts.getBoundingClientRect().left).toBeGreaterThanOrEqual(
          main.getBoundingClientRect().right,
        );
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      expect(skillPage.scrollWidth).toBeLessThanOrEqual(skillPage.clientWidth);
    },
  );

  it.each(["success", "error"] as const)(
    "shows %s install feedback in the reading column under the header's action",
    async (kind) => {
      const { page } = await import("vitest/browser");
      await page.viewport(390, 844);
      createContainer();
      renderSkills(
        createProps({
          clawhubDetailRef: "@fixture/calendar",
          clawhubDetail: {
            skill: { slug: "calendar", displayName: "Calendar", createdAt: 1, updatedAt: 2 },
          },
          clawhubInstallMessage: {
            ref: "@fixture/calendar",
            kind,
            text: "REVIEW RECOMMENDED — inspect this release before use.\n".repeat(6),
          },
        }),
        container!,
      );
      const skillPage = await renderedPage();
      const notice = query(".skill-page__notice", skillPage);
      const actions = query(".plugin-catalog-detail__actions", skillPage);
      const button = actions.querySelector<HTMLButtonElement>("button")!;
      expect(notice.getAttribute("role")).toBe(kind === "error" ? "alert" : "status");
      expect(button.disabled).toBe(kind === "success");
      expect(query(".plugin-catalog-detail__main", skillPage).contains(notice)).toBe(true);
      expect(actions.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        notice.getBoundingClientRect().top,
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    },
  );

  it.each([390, 1440])(
    "keeps a registry error on the page with its way back at %ipx",
    async (width) => {
      const { page } = await import("vitest/browser");
      await page.viewport(width, 844);
      createContainer();
      renderSkills(
        createProps({
          clawhubDetailRef: "example-skill",
          clawhubDetailError: "Read the source and report actionable findings.".repeat(20),
        }),
        container!,
      );
      const skillPage = await renderedPage();
      await expect.poll(() => skillPage.querySelector("[role=alert]")).not.toBeNull();
      const back = query(".plugins-settings-breadcrumb__parent", skillPage);
      expect(back.textContent).toBe("Skills");
      expect(query(".plugins-settings-breadcrumb__current", skillPage).textContent).toBe(
        "example-skill",
      );
      expect(skillPage.scrollWidth).toBeLessThanOrEqual(skillPage.clientWidth);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    },
  );
});
