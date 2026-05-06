import { describe, expect, it } from "vitest";
import {
  parseRenderedClawtributorEntries,
  renderClawtributorsBlock,
} from "../../scripts/update-clawtributors-render.js";

describe("scripts/update-clawtributors-render", () => {
  it("renders markdown contributor entries by default", () => {
    const block = renderClawtributorsBlock(
      [
        {
          display: "Andy",
          html_url: "https://github.com/andyk-ms",
          avatar_url: "https://avatars.githubusercontent.com/u/91510251?v=4&s=48",
        },
        {
          display: "Rajat Joshi",
          html_url: "https://github.com/18-RAJAT",
          avatar_url: "docs/assets/clawtributors/18-rajat.png",
        },
      ],
      {
        perLine: 10,
        avatarSize: 48,
        startMarker: "<!-- clawtributors:start -->",
        endMarker: "<!-- clawtributors:end -->",
      },
    );

    expect(block).toContain(
      "[![Andy](https://avatars.githubusercontent.com/u/91510251?v=4&s=48)](https://github.com/andyk-ms)",
    );
    expect(block).toContain(
      "[![Rajat Joshi](docs/assets/clawtributors/18-rajat.png)](https://github.com/18-RAJAT)",
    );
  });

  it("round-trips rendered markdown entries without losing contributors", () => {
    const entries = [
      {
        display: "Andy",
        html_url: "https://github.com/andyk-ms",
        avatar_url: "https://avatars.githubusercontent.com/u/91510251?v=4&s=48",
      },
      {
        display: "Rajat Joshi",
        html_url: "https://github.com/18-RAJAT",
        avatar_url: "docs/assets/clawtributors/18-rajat.png",
      },
      {
        display: 'Tom & "Jerry"',
        html_url: "https://github.com/example",
        avatar_url: "https://avatars.githubusercontent.com/u/1?v=4&s=48",
      },
    ];

    const block = renderClawtributorsBlock(entries, {
      perLine: 2,
      avatarSize: 48,
      startMarker: "<!-- clawtributors:start -->",
      endMarker: "<!-- clawtributors:end -->",
    });
    const parsed = parseRenderedClawtributorEntries(block);

    expect(parsed).toEqual(entries);
  });

  it("parses legacy html entries for seed compatibility", () => {
    const parsed = parseRenderedClawtributorEntries(
      `<a href="https://github.com/18-RAJAT"><img src="https://avatars.githubusercontent.com/u/78920780?v=4&amp;s=48" width="48" height="48" alt="Rajat Joshi" title="Rajat Joshi"/></a>`,
    );

    expect(parsed).toEqual([
      {
        display: "Rajat Joshi",
        html_url: "https://github.com/18-RAJAT",
        avatar_url: "https://avatars.githubusercontent.com/u/78920780?v=4&s=48",
      },
    ]);
  });

  it("keeps rendered contributor count aligned with the input set", () => {
    const entries = Array.from({ length: 3 }, (_, index) => ({
      display: `Contributor ${index + 1}`,
      html_url: `https://github.com/example-${index + 1}`,
      avatar_url: `docs/assets/clawtributors/example-${index + 1}.png`,
    }));

    const block = renderClawtributorsBlock(entries, {
      perLine: 2,
      avatarSize: 48,
      startMarker: "<!-- clawtributors:start -->",
      endMarker: "<!-- clawtributors:end -->",
    });

    expect(parseRenderedClawtributorEntries(block)).toHaveLength(entries.length);
  });

  it("escapes markdown-looking display names without breaking count validation", () => {
    const entries = [
      {
        display: "[![x](u)](h)",
        html_url: "https://github.com/example-markdown-alt",
        avatar_url: "docs/assets/clawtributors/example-markdown-alt.png",
      },
    ];

    expect(() =>
      renderClawtributorsBlock(entries, {
        perLine: 10,
        avatarSize: 48,
        startMarker: "<!-- clawtributors:start -->",
        endMarker: "<!-- clawtributors:end -->",
      }),
    ).not.toThrow();
  });
});
