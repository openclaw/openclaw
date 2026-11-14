import "../test-utils/prepare-compiled-subprocesses.js";
import { DOMParser } from "linkedom";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  renderPublicSessionCardPng,
  type PublicSessionCard,
} from "./control-ui-public-session-card-render.js";
import { createPublicSessionCardRenderer } from "./control-ui-public-session-card.js";

const rasterizerInput = vi.hoisted(() => vi.fn<(svg: string) => void>());

// Inspect the production rasterizer input; the worker PNG test loads its own real module.
vi.mock("@resvg/resvg-js", () => ({
  Resvg: class {
    constructor(svg: string) {
      rasterizerInput(svg);
    }
    render() {
      return { asPng: () => Buffer.alloc(0) };
    }
  },
}));

const CARD: PublicSessionCard = {
  title: "A clearer public session preview",
  quote: "Show what this session accomplished.",
  agentName: "Claw",
  messageCount: 18,
  status: "Done",
  host: "example.test",
};

function render(card: PublicSessionCard) {
  rasterizerInput.mockClear();
  renderPublicSessionCardPng(card);
  const svg = rasterizerInput.mock.calls[0]![0];
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  return { svg, document, text: document.documentElement.textContent };
}

describe("public session preview card", () => {
  it("uses the headline until a recorded worktree has changes", () => {
    for (const worktree of [undefined, { branch: "main", additions: 0, deletions: 0, files: 0 }]) {
      const { text } = render({ ...CARD, worktree });
      expect(text).toContain(CARD.quote);
      expect(text).toContain("Done");
      expect(text).not.toContain("Changes");
    }
    const { text } = render({
      ...CARD,
      repoSlug: "org/repo",
      durationMinutes: 12,
      worktree: { branch: "fix", additions: 1, deletions: 2, files: 3, prState: "Merged" },
    });
    for (const part of ["Changes+1−23 files", "18 messages · 12 min", "org/repo · fix", "Merged"]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain("Checks");
  });

  it("omits unknown optional facts and includes only recorded checks", () => {
    const card = { title: "A short session", host: "example.test", messageCount: 2 };
    expect(render(card).text).toBe(
      "OpenClaw · Public sessionA short session2 messagesexample.test",
    );
    const { text } = render({
      ...card,
      worktree: { branch: "feature", files: 1, checks: "All 4 checks passed" },
    });
    expect(text).toContain("ChecksAll 4 checks passed");
    expect(text).not.toMatch(/undefined|Merged| min|by /u);
  });

  it("keeps untrusted text inert in every card field", () => {
    const input = '<script href="bad">&</script>';
    const card = { ...CARD, title: input, quote: input, agentName: input, host: input };
    for (const worktree of [undefined, { branch: input, files: 1, checks: input }]) {
      const { document, text } = render({ ...card, repoSlug: input, worktree });
      expect(document.querySelector("script, image, foreignObject, a")).toBeNull();
      expect(text).toContain(input);
    }
  });

  it.each([true, false])("wraps and positions long preview text (unspaced: %s)", (unspaced) => {
    const { document, text } = render({
      ...CARD,
      title: unspaced ? `${"W".repeat(2_000)}TITLE_END` : "A very long title ".repeat(30),
      quote: unspaced ? `${"W".repeat(2_000)}QUOTE_END` : CARD.quote,
    });
    const titles = [...document.querySelectorAll('text[font-size="56"]')];
    const quotes = [...document.querySelectorAll('text[font-family="Instrument Serif"]')];
    if (unspaced) {
      for (const lines of [titles, quotes]) {
        expect(lines).toHaveLength(3);
        expect(lines.at(-1)?.textContent).toMatch(/…$/u);
      }
      expect(text).not.toMatch(/TITLE_END|QUOTE_END/u);
      expect(text?.length).toBeLessThan(500);
    }
    const gap = Number(quotes[0]?.getAttribute("y")) - Number(titles.at(-1)?.getAttribute("y"));
    expect(gap).toBeGreaterThan(50);
    expect(gap).toBeLessThan(80);
  });

  it("renders bundled fonts into a 1200 by 630 PNG through the worker", async () => {
    const renderer = createPublicSessionCardRenderer();
    onTestFinished(() => renderer.dispose());
    const png = await renderer.render(CARD);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(png.byteLength).toBeGreaterThan(10_000);
  });
});
