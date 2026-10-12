import "../test-utils/prepare-compiled-subprocesses.js";
import { DOMParser } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  renderPublicSessionCardSvg,
  type PublicSessionCard,
} from "./control-ui-public-session-card-render.js";
import { createPublicSessionCardRenderer } from "./control-ui-public-session-card.js";

const CARD: PublicSessionCard = {
  title: "A clearer public session preview",
  quote: "Show what this session accomplished.",
  agentName: "Claw",
  messageCount: 18,
  status: "Done",
  host: "example.test",
};

function parse(card: PublicSessionCard) {
  return new DOMParser().parseFromString(renderPublicSessionCardSvg(card), "image/svg+xml");
}

describe("public session preview card", () => {
  it("uses the headline until a recorded worktree has changes", () => {
    for (const worktree of [undefined, { branch: "main", additions: 0, deletions: 0, files: 0 }]) {
      const document = parse({ ...CARD, worktree });
      expect(document.documentElement.textContent).toContain(CARD.quote);
      expect(document.documentElement.textContent).toContain("Done");
      expect(document.documentElement.textContent).not.toContain("Changes");
    }
    const document = parse({
      ...CARD,
      repoSlug: "openclaw/example",
      durationMinutes: 12,
      worktree: {
        branch: "feat/previews",
        additions: 34,
        deletions: 8,
        files: 3,
        prState: "Merged",
      },
    });
    expect(document.documentElement.textContent).toContain("Changes+34−83 files");
    expect(document.documentElement.textContent).toContain("18 messages · 12 min");
    expect(document.documentElement.textContent).toContain("openclaw/example · feat/previews");
    expect(document.documentElement.textContent).toContain("Merged");
    expect(document.documentElement.textContent).not.toContain("Checks");
  });

  it("omits unknown optional facts and includes only recorded checks", () => {
    const headline = parse({ title: "A short session", host: "example.test", messageCount: 2 });
    expect(headline.documentElement.textContent).toBe(
      "OpenClaw · Public sessionA short session2 messagesexample.test",
    );
    const receipt = parse({
      title: "A short session",
      host: "example.test",
      messageCount: 2,
      worktree: { branch: "feature", files: 1, checks: "All 4 checks passed" },
    });
    expect(receipt.documentElement.textContent).toContain("ChecksAll 4 checks passed");
    expect(receipt.documentElement.textContent).not.toMatch(/undefined|Merged| min|by /u);
  });

  it("keeps untrusted text inert in every card field", () => {
    const injection = '<script href="bad">&</script>';
    const card = {
      ...CARD,
      title: injection,
      quote: injection,
      agentName: injection,
      host: injection,
    };
    for (const worktree of [undefined, { branch: injection, files: 1, checks: injection }]) {
      const document = parse({ ...card, repoSlug: injection, worktree });
      expect(document.querySelector("script, image, foreignObject, a")).toBeNull();
      expect(document.documentElement.textContent).toContain(injection);
      expect(renderPublicSessionCardSvg({ ...card, worktree })).toContain("&lt;script");
    }
  });

  it("bounds long text and breaks unspaced text into at most three title and quote lines", () => {
    const document = parse({
      ...CARD,
      title: `${"W".repeat(2_000)}TITLE_END`,
      quote: `${"W".repeat(2_000)}QUOTE_END`,
    });
    const titles = [...document.querySelectorAll('text[font-size="56"]')];
    const quotes = [...document.querySelectorAll('text[font-family="Instrument Serif"]')];
    expect(titles).toHaveLength(3);
    expect(quotes).toHaveLength(3);
    expect(titles.at(-1)?.textContent).toMatch(/…$/u);
    expect(quotes.at(-1)?.textContent).toMatch(/…$/u);
    expect(document.documentElement.textContent).not.toMatch(/TITLE_END|QUOTE_END/u);
    expect(document.documentElement.textContent?.length).toBeLessThan(500);
  });

  it.each([
    "A short title",
    "A longer public session title that wraps across the card",
    "A very long title ".repeat(30),
  ])("keeps the opening quote directly below the title: %s", (title) => {
    const document = parse({ ...CARD, title });
    const titleLines = [...document.querySelectorAll('text[font-size="56"]')];
    const lastTitleY = Number(titleLines.at(-1)?.getAttribute("y"));
    const quoteY = Number(
      document.querySelector('text[font-family="Instrument Serif"]')?.getAttribute("y"),
    );
    expect(quoteY - lastTitleY).toBeGreaterThan(50);
    expect(quoteY - lastTitleY).toBeLessThan(80);
  });

  it("renders bundled fonts into a 1200 by 630 PNG through the worker", async () => {
    const renderer = createPublicSessionCardRenderer();
    try {
      const png = await renderer.render(CARD);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.readUInt32BE(16)).toBe(1200);
      expect(png.readUInt32BE(20)).toBe(630);
      expect(png.byteLength).toBeGreaterThan(10_000);
    } finally {
      await renderer.dispose();
    }
  });
});
