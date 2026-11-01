import { expect, it, vi } from "vitest";
import "../../styles.css";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createContext } from "./skill-workshop-page.test-support.ts";
import { SkillWorkshopPage } from "./skill-workshop-page.tsx";

it("grows the skill reader with the list and keeps a bounded reader when stacked", async () => {
  const { page } = await import("vitest/browser");
  await page.viewport(1440, 900);
  const content =
    "# Review procedure\n\n" + "Read the source and report actionable findings.\n\n".repeat(150);
  const request = vi.fn(async (method: string, params: { agentId: string }) => {
    if (method === "skills.workshop.list") {
      return {
        agentId: params.agentId,
        mode: "off",
        root: "/synthetic/workshop",
        skills: Array.from({ length: params.agentId === "research" ? 3 : 16 }, (_, index) => ({
          name: `review-${index}`,
          description: "Review the source and preserve existing behavior.",
          updatedAtMs: Date.now(),
          sizeBytes: content.length,
          files: ["SKILL.md", "references/checklist.txt"],
        })),
        archived: [],
      };
    }
    if (method === "skills.workshop.changes") {
      return { changes: [] };
    }
    if (method === "skills.workshop.read") {
      return { content, files: ["SKILL.md", "references/checklist.txt"] };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const context = createContext(request);
  const mounted = mountSolid(() => <SkillWorkshopPage />, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  try {
    await waitForSolid(() =>
      expect(mounted.container.querySelector(".sw-markdown")).not.toBeNull(),
    );
    const find = (selector: string) => mounted.container.querySelector<HTMLElement>(selector)!;
    const assertAligned = () => {
      const list = find(".sw-list").getBoundingClientRect();
      const detail = find(".sw-detail").getBoundingClientRect();
      expect(detail.top).toBeCloseTo(list.top, 0);
      expect(detail.bottom).toBeCloseTo(list.bottom, 0);
    };
    const assertScrollable = () => {
      const body = find(".sw-detail__body");
      expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
      body.scrollTop = body.scrollHeight;
      expect(body.scrollTop).toBeGreaterThan(0);
      body.scrollTop = 0;
    };
    assertAligned();
    assertScrollable();
    const initialHeight = find(".sw-detail__body").clientHeight;
    context.agentSelection.set("scout");
    await waitForSolid(() =>
      expect(mounted.container.querySelectorAll(".sw-row")).toHaveLength(16),
    );
    await waitForSolid(() => expect(find(".sw-markdown")).not.toBeNull());
    assertAligned();
    assertScrollable();
    expect(find(".sw-detail__body").clientHeight).toBeGreaterThan(initialHeight + 100);

    mounted.getByRole("button", { name: /^Files/ }).click();
    await waitForSolid(() => expect(find(".sw-file")).not.toBeNull());
    assertScrollable();
    mounted.getByRole("button", { name: /^Instructions$/ }).click();
    await waitForSolid(() => expect(find(".sw-markdown")).not.toBeNull());

    await page.viewport(390, 844);
    const list = find(".sw-list").getBoundingClientRect();
    const detail = find(".sw-detail").getBoundingClientRect();
    expect(detail.top).toBeGreaterThanOrEqual(list.bottom);
    expect(find(".sw-detail__body").clientHeight).toBeLessThanOrEqual(window.innerHeight * 0.7 + 1);
    expect(detail.right).toBeLessThanOrEqual(window.innerWidth);
    assertScrollable();
  } finally {
    mounted.unmount();
  }
});
