import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import "../../styles.css";
import { createProps } from "./view.test-support.ts";
import { renderSkills } from "./view.ts";

const container = document.createElement("openclaw-skills-page");

afterEach(() => {
  render(null, container);
  container.remove();
});

describe("ClawHub detail content", () => {
  it.each([390, 1440])("contains long plain-text details at %ipx", async (width) => {
    await page.viewport(width, 960);
    document.body.append(container);
    const changelog = `# Release notes\n\n<em>Keep this literal</em>\n${"long_identifier_".repeat(80)}\nLast line`;
    render(
      renderSkills(
        createProps({
          clawhubDetailRef: "@fixture/guide",
          clawhubDetail: {
            skill: {
              slug: "guide",
              displayName: "Guide",
              summary: `Review and verification instructions. ${"long_summary_".repeat(80)}`,
              createdAt: 1,
              updatedAt: 2,
            },
            owner: { displayName: "Fixture operator" },
            latestVersion: { version: "1.0.0", createdAt: 2, changelog },
          },
        }),
      ),
      container,
    );
    const body = container.querySelector<HTMLElement>(".skill-reader-dialog__body")!;
    await expect
      .element(page.getByRole("button", { name: "Install Guide", exact: true }))
      .toBeVisible();
    expect(body.clientWidth).toBeGreaterThan(0);
    expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth);
    for (const child of body.children) {
      expect(child.scrollWidth).toBeLessThanOrEqual(child.clientWidth);
    }
    const changelogElement = Array.from(body.children).find((child) =>
      child.textContent?.includes("# Release notes"),
    );
    expect(changelogElement?.textContent).toBe(changelog);
    expect(changelogElement?.children).toHaveLength(0);
  });
});
