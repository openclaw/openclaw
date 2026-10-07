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
  it.each([390, 1440])("contains rendered Markdown details at %ipx", async (width) => {
    await page.viewport(width, 960);
    document.body.append(container);
    const code = "long_identifier_".repeat(80);
    const tableIdentifier = "table_identifier_".repeat(80);
    const changelog = `# Release notes\n\nFirst paragraph starts here.\n\n\`\`\`text\n${code}\n\`\`\`\n\n| Change | Status |\n| --- | --- |\n| ${tableIdentifier} | Ready |\n\n<img src="javascript:alert(1)" onerror="alert(1)">`;
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
    expect(body.querySelector("h1")?.textContent).toBe("Release notes");
    expect(body.querySelector("article > p")?.textContent).toBe("First paragraph starts here.");
    expect(body.querySelector("pre code")?.textContent).toBe(`${code}\n`);
    const table = body.querySelector("table")!;
    expect(table.scrollWidth).toBeGreaterThan(table.clientWidth);
    table.scrollLeft = 100;
    expect(table.scrollLeft).toBeGreaterThan(0);
    expect(body.querySelector("[onerror], [src^='javascript:']")).toBeNull();
  });
});
