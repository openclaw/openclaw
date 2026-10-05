// Control UI tests cover markdown behavior.
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("toSanitizedMarkdownHtml", () => {
  describe("code blocks", () => {
    const jsonBlock = (lineCount: number) => {
      const values = Array.from({ length: lineCount - 2 }, (_, index) => `  ${index},`);
      values[values.length - 1] = values.at(-1)?.slice(0, -1) ?? "";
      return `\`\`\`json\n[\n${values.join("\n")}\n]\n\`\`\``;
    };

    it("separates cached GitHub references by repository and absent context", () => {
      const source = "PR #141270";
      for (const githubRepo of [
        { owner: "first", repo: "one" },
        { owner: "second", repo: "one" },
        { owner: "second", repo: "two" },
        null,
      ]) {
        const fragment = htmlFragment(toSanitizedMarkdownHtml(source, { githubRepo }));
        expect(fragment.querySelector("a")?.getAttribute("href") ?? null).toBe(
          githubRepo
            ? `https://github.com/${githubRepo.owner}/${githubRepo.repo}/pull/141270`
            : null,
        );
      }
    });

    it("separates identical short references and aliases across verified hosts", () => {
      for (const host of ["github.com", "microsoft.ghe.com", "github.com"]) {
        const githubRepo = { owner: "bic", repo: "lobster", host };
        for (const source of ["PR #17420", "Lobster PR #17420"]) {
          const html = toSanitizedMarkdownHtml(source, {
            githubRepo,
            githubRepositories: [{ ...githubRepo, aliases: ["Lobster"] }],
          });
          expect(htmlFragment(html).querySelector("a")?.getAttribute("href")).toBe(
            `https://${host}/bic/lobster/pull/17420`,
          );
        }
      }
    });

    it("refreshes preview eligibility when colliding aliases retain a different host", () => {
      const source = "https://two.ghe.com/bic/lobster/issues/42\n\nTail";
      for (const host of ["two.ghe.com", "three.ghe.com", "two.ghe.com"]) {
        const options = {
          githubRepositories: [
            { owner: "bic", repo: "lobster", host: "one.ghe.com", aliases: ["Lobster"] },
            { owner: "bic", repo: "lobster", host, aliases: ["Lobster"] },
          ],
        };
        for (const rendered of [
          toSanitizedMarkdownHtml(source, options),
          toStreamingMarkdownParts(source, options, "colliding-repository-hosts").join(""),
        ]) {
          const anchor = htmlFragment(rendered).querySelector("a");
          expect(anchor?.getAttribute("href")).toBe("https://two.ghe.com/bic/lobster/issues/42");
          expect(anchor?.classList.contains("markdown-github-preview")).toBe(
            host === "two.ghe.com",
          );
        }
      }
    });

    it("refreshes qualified references when colliding repositories exchange origins", () => {
      const source = "first/lobster#1234\n\nTail";
      for (const host of ["one.ghe.com", "two.ghe.com", "one.ghe.com", "invalid/path"]) {
        const options = {
          githubRepositories: [
            { owner: "first", repo: "lobster", host, aliases: ["Lobster"] },
            {
              owner: "second",
              repo: "lobster",
              host: host === "one.ghe.com" ? "two.ghe.com" : "one.ghe.com",
              aliases: ["Lobster"],
            },
          ],
        };
        for (const rendered of [
          toSanitizedMarkdownHtml(source, options),
          toStreamingMarkdownParts(source, options, "colliding-repository-origins").join(""),
        ]) {
          expect(htmlFragment(rendered).querySelector("a")?.getAttribute("href") ?? null).toBe(
            host === "invalid/path" ? null : `https://${host}/first/lobster/issues/1234`,
          );
        }
      }
    });

    it("invalidates public qualified references when a known origin refuses linking", () => {
      const source = "first/lobster#1234\n\nTail";
      for (const githubRepositories of [
        [],
        [{ owner: "first", repo: "lobster", host: "invalid/path", aliases: [] }],
        [],
      ]) {
        const options = { githubRepositories };
        for (const rendered of [
          toSanitizedMarkdownHtml(source, options),
          toStreamingMarkdownParts(source, options, "invalid-qualified-origin").join(""),
        ]) {
          expect(htmlFragment(rendered).querySelector("a")?.getAttribute("href") ?? null).toBe(
            githubRepositories.length ? null : "https://github.com/first/lobster/issues/1234",
          );
        }
      }
    });

    it("invalidates named-reference caches as authorized aliases arrive, collide, and disappear", () => {
      const githubRepo = { owner: "openclaw", repo: "openclaw" };
      const source = "ClawSweeper PR #1576";
      const known = { owner: "openclaw", repo: "clawsweeper", aliases: ["ClawSweeper"] };
      for (const [githubRepositories, expected] of [
        [[], null],
        [[known], "https://github.com/openclaw/clawsweeper/pull/1576"],
        [[known, { aliases: ["ClawSweeper"] }], null],
        [[], null],
      ] as const) {
        expect(
          htmlFragment(toSanitizedMarkdownHtml(source, { githubRepo, githubRepositories }))
            .querySelector("a")
            ?.getAttribute("href") ?? null,
        ).toBe(expected);
      }
    });

    it("keeps the no-chrome code-block cache separate from copy-enabled rendering", () => {
      const markdown = "```\ncode\n```";
      const plain = toSanitizedMarkdownHtml(markdown, { codeBlockChrome: "none" });
      const copyable = toSanitizedMarkdownHtml(markdown);

      expect(htmlFragment(plain).querySelector(".code-block-copy")).toBeNull();
      expect(htmlFragment(copyable).querySelector(".code-block-copy")).toBeInstanceOf(
        HTMLButtonElement,
      );
    });

    it("keeps the interactive code-block cache separate from static rendering", () => {
      const markdown = jsonBlock(41);
      const staticHtml = toSanitizedMarkdownHtml(markdown);
      const interactiveHtml = toSanitizedMarkdownHtml(markdown, {
        codeBlockInteraction: "interactive",
      });

      expect(htmlFragment(staticHtml).querySelector(".code-block-expand")).toBeNull();
      expect(htmlFragment(interactiveHtml).querySelector(".code-block-expand")).toBeInstanceOf(
        HTMLButtonElement,
      );
    });
  });

  describe("large text handling", () => {
    it("does not build cache keys for replies larger than the cache limit", () => {
      const locale = vi.spyOn(i18n, "getLocale");

      expect(toSanitizedMarkdownHtml("x".repeat(50_001))).toContain("x".repeat(100));
      expect(locale).not.toHaveBeenCalled();
      locale.mockRestore();
    });

    it("uses plain text fallback for oversized content", () => {
      // MARKDOWN_PARSE_LIMIT is 40_000 chars
      const paragraphs = Array.from(
        { length: 220 },
        (_, i) =>
          `Paragraph ${i + 1}: ${Array.from({ length: 8 }, () => "Long plain-text reply.").join(
            " ",
          )}`,
      ).join("\n\n");
      const input = `Résumé 😀: Alice's "ready & waiting"; 12 < 20, 7 > 3.\r\nNext\tcolumn\u2028last\u0000line\n${paragraphs}`;
      const html = toSanitizedMarkdownHtml(input);
      const fallback = htmlFragment(html).firstElementChild;
      expect(fallback?.tagName).toBe("DIV");
      expect(fallback?.className).toBe("markdown-plain-text-fallback");
      expect(fallback?.textContent).toBe(
        `Résumé 😀: Alice's "ready & waiting"; 12 < 20, 7 > 3.\nNext\tcolumn\nlastline\n${paragraphs}`,
      );
      expect(html).not.toContain("\u0000");
    });

    it("preserves indentation in plain text fallback", () => {
      const input = `${"Header line\n".repeat(3400)}\n    indented log line\n        deeper indent`;
      const html = toSanitizedMarkdownHtml(input);
      const fallback = htmlFragment(html).firstElementChild;
      expect(fallback?.className).toBe("markdown-plain-text-fallback");
      expect(fallback?.textContent).toBe(input);
    });
  });
});
