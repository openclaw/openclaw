import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSkillWorkshopDiff } from "../../lib/skill-workshop/diff.ts";
import { createSkillWorkshopState } from "./proposals.ts";
import {
  createContext,
  type SkillWorkshopPageTestElement,
} from "./skill-workshop-page.test-support.ts";
import "./skill-workshop-page.ts";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  localStorage.removeItem("openclaw:control-ui:skill-workshop-mode:v1");
});

describe("Workshop installed comparisons", () => {
  it.each([
    {
      previous: "Keep the existing check.",
      current: [
        "Keep the existing check.",
        ...Array.from({ length: 450 }, (_, index) => `Check release item ${index + 1}.`),
      ].join("\n"),
      name: "long insertion",
    },
    {
      previous: Array.from({ length: 700 }, (_, index) => `Check release item ${index + 1}.`).join(
        "\n",
      ),
      current: Array.from({ length: 700 }, (_, index) =>
        index === 9
          ? "Early instruction change."
          : index === 649
            ? "Mixed late instruction change."
            : `Check release item ${index + 1}.`,
      ).join("\n"),
      name: "early and late edits",
    },
  ])("opens the complete differing saved comparison for a $name", async ({ previous, current }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T10:00:00.000Z"));
    localStorage.setItem("openclaw:control-ui:skill-workshop-mode:v1", "skills");
    const state = createSkillWorkshopState();
    state.skillWorkshopAgentId = "research";
    state.skillWorkshopLoaded = true;
    state.skillWorkshopInstalledName = "release-review";
    state.skillWorkshopInstalledSkills = [
      {
        name: "unchanged-skill",
        skillKey: "unchanged-skill",
        description: "No changes",
        read: {
          status: "ready",
          name: "unchanged-skill",
          content: "Keep this instruction.",
          savedVersions: [
            {
              key: "unchanged",
              diff: computeSkillWorkshopDiff("Keep this instruction.", "Keep this instruction."),
            },
          ],
        },
      },
      {
        name: "release-review",
        skillKey: "release-review",
        description: "Release checks",
        read: {
          status: "ready",
          name: "release-review",
          content: current,
          savedVersions: [
            {
              key: "newest",
              appliedAt: "2026-08-17T10:00:00.000Z",
              diff: computeSkillWorkshopDiff(current, current),
            },
            {
              key: "older",
              appliedAt: "2026-08-16T10:00:00.000Z",
              diff: computeSkillWorkshopDiff(previous, current),
            },
          ],
        },
      },
    ];
    const page = document.createElement(
      "openclaw-skill-workshop-page",
    ) as SkillWorkshopPageTestElement;
    page.state = state;
    page.context = createContext(vi.fn());
    document.body.append(page);
    await page.updateComplete;

    const reader = page.querySelector(".sw-collection__reader");
    expect(page.querySelector(".sw-installed-skill__name")?.textContent).toBe("release-review");
    expect(page.querySelector(".sw-installed-skill__change")?.textContent?.trim()).toBe(
      "Changes since 37d ago",
    );
    const versions = reader?.querySelectorAll("details");
    expect(versions?.[0]?.open).toBe(false);
    expect(versions?.[1]?.open).toBe(true);
    expect(
      Array.from(
        reader!.querySelectorAll(
          "details[open] .chat-diff__row:not(.chat-diff__row--del) .chat-diff__text",
        ),
        (line) => line.textContent,
      ),
    ).toEqual(current.split("\n"));
    expect(reader?.querySelector(".sidebar-markdown")).toBeNull();
    expect(reader?.querySelector(".chat-diff__row--skip")).toBeNull();
  });
});
