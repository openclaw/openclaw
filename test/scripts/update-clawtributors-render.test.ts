import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseClawtributorEntries,
  renderClawtributorEntry,
  renderClawtributorRows,
} from "../../scripts/update-clawtributors-render.js";

const CLAWTRIBUTORS_START = "<!-- clawtributors:start -->";
const CLAWTRIBUTORS_END = "<!-- clawtributors:end -->";
const CLAWTRIBUTORS_HIDDEN_START = "<!-- clawtributors:hidden:start";
const CLAWTRIBUTORS_HIDDEN_END = "clawtributors:hidden:end -->";

const baseEntry = {
  display: "Jane Contributor",
  html_url: "https://github.com/jane",
  avatar_url: "https://avatars.githubusercontent.com/u/123?v=4&s=48",
};

describe("update-clawtributors render helpers", () => {
  it("renders a fixed-size linked HTML image", () => {
    expect(renderClawtributorEntry(baseEntry)).toBe(
      '[<img src="https://avatars.githubusercontent.com/u/123?v=4&amp;s=48" alt="Jane Contributor" width="48">](https://github.com/jane)',
    );
  });

  it("escapes HTML attributes in src and alt text", () => {
    expect(
      renderClawtributorEntry({
        display: `github-actions[bot] "runner" <>&`,
        html_url: "https://github.com/apps/github-actions",
        avatar_url: `https://avatars.githubusercontent.com/in/15368?v=4&s=48&name="<>`,
      }),
    ).toBe(
      '[<img src="https://avatars.githubusercontent.com/in/15368?v=4&amp;s=48&amp;name=&quot;&lt;&gt;" alt="github-actions[bot] &quot;runner&quot; &lt;&gt;&amp;" width="48">](https://github.com/apps/github-actions)',
    );
  });

  it("keeps bot-style names as plain alt text", () => {
    const rendered = renderClawtributorEntry({
      ...baseEntry,
      display: "github-actions[bot]",
      html_url: "https://github.com/apps/github-actions",
    });

    expect(rendered).toContain('alt="github-actions[bot]"');
    expect(rendered).toContain('width="48"');
    expect(rendered).not.toContain('height="48"');
    expect(rendered).not.toContain("![");
  });

  it("chunks entries into stable ten-wide rows", () => {
    const entries = Array.from({ length: 11 }, (_, index) => ({
      display: `Contributor ${index + 1}`,
      html_url: `https://github.com/user-${index + 1}`,
      avatar_url: `https://avatars.githubusercontent.com/u/${index + 1}?v=4&s=48`,
    }));

    const rows = renderClawtributorRows(entries, 10);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.match(/<img /g)).toHaveLength(10);
    expect(rows[1]?.match(/<img /g)).toHaveLength(1);
    expect(rows.join("\n")).not.toContain("<table>");
  });

  it("parses linked inline HTML images without falling back to display-derived URLs", () => {
    const block = [
      '[<img src="https://avatars.githubusercontent.com/in/15368?v=4&amp;s=48" alt="github-actions[bot]" width="48">](https://github.com/apps/github-actions)',
      '[<img src="https://avatars.githubusercontent.com/u/6668807?v=4&amp;s=48" alt="Jamieson O&apos;Reilly" width="48">](https://github.com/orlyjamie)',
    ].join(" ");

    expect(parseClawtributorEntries(block)).toEqual([
      {
        display: "github-actions[bot]",
        avatar_url: "https://avatars.githubusercontent.com/in/15368?v=4&s=48",
        html_url: "https://github.com/apps/github-actions",
      },
      {
        display: "Jamieson O'Reilly",
        avatar_url: "https://avatars.githubusercontent.com/u/6668807?v=4&s=48",
        html_url: "https://github.com/orlyjamie",
      },
    ]);
  });

  it("keeps the committed README clawtributors block in the compact fixed-width shape", () => {
    const readme = readFileSync("README.md", "utf8");
    const block = readmeBlock(readme, CLAWTRIBUTORS_START, CLAWTRIBUTORS_END);
    const rows = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const rowCounts = rows.map((row) => row.match(/<img /g)?.length ?? 0);
    const imageCount = rowCounts.reduce((sum, count) => sum + count, 0);

    expect(imageCount).toBeGreaterThan(0);
    expect(block).not.toContain("![");
    expect(block).not.toContain("<table");
    expect(block).not.toContain('height="48"');
    expect(block.match(/width="48"/g)).toHaveLength(imageCount);
    expect(rowCounts.slice(0, -1).every((count) => count === 10)).toBe(true);
    expect(rowCounts.at(-1)).toBeGreaterThan(0);
    expect(rowCounts.at(-1)).toBeLessThanOrEqual(10);

    const hiddenBlock = readmeBlock(readme, CLAWTRIBUTORS_HIDDEN_START, CLAWTRIBUTORS_HIDDEN_END);
    expect(hiddenBlock).toContain("default-avatar-cache:");
  });
});

function readmeBlock(readme: string, startMarker: string, endMarker: string): string {
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return readme.slice(start + startMarker.length, end);
}
