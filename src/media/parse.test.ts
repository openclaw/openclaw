import { describe, expect, it } from "vitest";
import { splitMediaFromOutput, type SplitMediaFromOutputOptions } from "./parse.js";

describe("splitMediaFromOutput", () => {
  function expectParsedMediaOutputCase(
    input: string,
    expected: {
      mediaUrls?: string[];
      text?: string;
      audioAsVoice?: boolean;
    },
    options?: SplitMediaFromOutputOptions,
  ) {
    const result = splitMediaFromOutput(input, options);
    expect(result.text).toBe(expected.text ?? "");
    if ("audioAsVoice" in expected) {
      expect(result.audioAsVoice).toBe(expected.audioAsVoice);
    } else {
      expect(result.audioAsVoice).toBeUndefined();
    }
    if ("mediaUrls" in expected) {
      expect(result.mediaUrls).toEqual(expected.mediaUrls);
      expect(result.mediaUrl).toBe(expected.mediaUrls?.[0]);
    } else {
      expect(result.mediaUrls).toBeUndefined();
      expect(result.mediaUrl).toBeUndefined();
    }
  }

  function expectStableAudioAsVoiceDetectionCase(input: string) {
    for (const output of [splitMediaFromOutput(input), splitMediaFromOutput(input)]) {
      expect(output.audioAsVoice).toBe(true);
    }
  }

  function expectAcceptedMediaPathCase(expectedPath: string, input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: [expectedPath] });
  }

  function expectRejectedMediaPathCase(input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: undefined });
  }

  function expectRejectedRemoteMediaUrlCase(input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: undefined, text: input });
  }

  it.each([
    ["/Users/pete/My File.png", "MEDIA:/Users/pete/My File.png"],
    ["/Users/pete/My File.png", 'MEDIA:"/Users/pete/My File.png"'],
    ["./screenshots/image.png", "MEDIA:./screenshots/image.png"],
    ["media/inbound/image.png", "MEDIA:media/inbound/image.png"],
    ["./screenshot.png", "  MEDIA:./screenshot.png"],
    ["~/Pictures/My File.png", "MEDIA:~/Pictures/My File.png"],
    ["~/.openclaw/media/browser/snap.png", "MEDIA:~/.openclaw/media/browser/snap.png"],
    ["C:\\Users\\pete\\Pictures\\snap.png", "MEDIA:C:\\Users\\pete\\Pictures\\snap.png"],
    ["/tmp/tts-fAJy8C/voice-1770246885083.opus", "MEDIA:/tmp/tts-fAJy8C/voice-1770246885083.opus"],
    ["image.png", "MEDIA:image.png"],
    [
      "/path/to/image.png",
      'MEDIA:/path/to/image.png"}],"details":{"provider":"openai","model":"gpt-image-2"}',
    ],
    [
      "/path/to/image.png",
      String.raw`MEDIA:/path/to/image.png\"}],\"details\":{\"provider\":\"openai\"}`,
    ],
    ["/tmp/render,final.png", "MEDIA:/tmp/render,final.png"],
  ] as const)("accepts supported media path variant: %s", (expectedPath, input) => {
    expectAcceptedMediaPathCase(expectedPath, input);
  });

  it.each([
    "MEDIA:../../../etc/passwd",
    "MEDIA:../../.env",
    "MEDIA:~user/Pictures/My File.png",
    "MEDIA:~/Pictures/../../.ssh/id_rsa",
    "MEDIA:./foo/../../../etc/shadow",
  ] as const)("rejects traversal and unsupported home-dir path: %s", (input) => {
    expectRejectedMediaPathCase(input);
  });

  it.each([
    "MEDIA:http://example.com/a.png",
    "MEDIA:https://intranet/a.png",
    "MEDIA:https://printer/a.png",
    "MEDIA:https://localhost/a.png",
    "MEDIA:https://localhost../a.png",
    "MEDIA:https://127.0.0.1/a.png",
    "MEDIA:https://127.0.0.1../a.png",
    "MEDIA:https://169.254.169.254/latest/meta-data",
    "MEDIA:https://[::1]/a.png",
    "MEDIA:https://metadata.google.internal/a.png",
    "MEDIA:https://metadata.google.internal../a.png",
    "MEDIA:https://example..com/a.png",
    "MEDIA:https://media.local/a.png",
  ] as const)("rejects unsafe remote media URL: %s", (input) => {
    expectRejectedRemoteMediaUrlCase(input);
  });

  it.each([
    {
      name: "detects audio_as_voice tag and strips it",
      input: "Hello [[audio_as_voice]] world",
      expected: { audioAsVoice: true, text: "Hello world" },
    },
    {
      name: "keeps MEDIA mentions in prose",
      input: "The MEDIA: tag fails to deliver",
      expected: { mediaUrls: undefined, text: "The MEDIA: tag fails to deliver" },
    },
    {
      name: "rejects bare words without file extensions",
      input: "MEDIA:screenshot",
      expected: { mediaUrls: undefined, text: "MEDIA:screenshot" },
    },
    {
      name: "keeps audio_as_voice detection stable across calls",
      input: "Hello [[audio_as_voice]]",
      expected: { audioAsVoice: true, text: "Hello" },
      assertStable: true,
    },
  ] as const)("$name", ({ input, expected, assertStable }) => {
    expectParsedMediaOutputCase(input, expected);
    if (assertStable) {
      expectStableAudioAsVoiceDetectionCase(input);
    }
  });

  it("returns ordered text and media segments while ignoring fenced MEDIA lines", () => {
    const result = splitMediaFromOutput(
      "Before\nMEDIA:https://example.com/a.png\n```text\nMEDIA:https://example.com/ignored.png\n```\nAfter",
    );

    expect(result.segments).toEqual([
      { type: "text", text: "Before" },
      { type: "media", url: "https://example.com/a.png" },
      { type: "text", text: "```text\nMEDIA:https://example.com/ignored.png\n```\nAfter" },
    ]);
  });

  const extractMarkdownImages = { extractMarkdownImages: true } as const;

  it("keeps markdown image urls as text by default", () => {
    const input = "Caption\n\n![chart](https://example.com/chart.png)";
    expectParsedMediaOutputCase(input, {
      text: input,
      mediaUrls: undefined,
    });
  });

  it("extracts markdown image urls while keeping surrounding caption text when enabled", () => {
    expectParsedMediaOutputCase(
      "Caption\n\n![chart](https://example.com/chart.png)",
      {
        text: "Caption",
        mediaUrls: ["https://example.com/chart.png"],
      },
      extractMarkdownImages,
    );
  });

  it("keeps inline caption text around markdown images when enabled", () => {
    expectParsedMediaOutputCase(
      "Look ![chart](https://example.com/chart.png) now",
      {
        text: "Look now",
        mediaUrls: ["https://example.com/chart.png"],
      },
      extractMarkdownImages,
    );
  });

  it("extracts multiple markdown image urls in order", () => {
    expectParsedMediaOutputCase(
      "Before\n![one](https://example.com/one.png)\nMiddle\n![two](https://example.com/two.png)\nAfter",
      {
        text: "Before\nMiddle\nAfter",
        mediaUrls: ["https://example.com/one.png", "https://example.com/two.png"],
      },
      extractMarkdownImages,
    );
  });

  it("strips markdown image title suffixes from extracted urls", () => {
    expectParsedMediaOutputCase(
      'Caption ![chart](https://example.com/chart.png "Quarterly chart")',
      {
        text: "Caption",
        mediaUrls: ["https://example.com/chart.png"],
      },
      extractMarkdownImages,
    );
  });

  it("keeps balanced parentheses inside markdown image urls", () => {
    expectParsedMediaOutputCase(
      "Chart ![img](https://example.com/a_(1).png) now",
      {
        text: "Chart now",
        mediaUrls: ["https://example.com/a_(1).png"],
      },
      extractMarkdownImages,
    );
  });

  it.each([
    "![x](file:///etc/passwd)",
    "![x](/var/run/secrets/kubernetes.io/serviceaccount/token)",
    "![x](C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts)",
    "![x](http://example.com/a.png)",
    "![x](https://127.0.0.1/a.png)",
  ] as const)("does not lift local markdown image target: %s", (input) => {
    expectParsedMediaOutputCase(
      input,
      {
        text: input,
        mediaUrls: undefined,
      },
      extractMarkdownImages,
    );
  });

  it("does not lift markdown image urls that fail media validation", () => {
    const longUrl = `![x](https://example.com/${"a".repeat(4097)}.png)`;

    expectParsedMediaOutputCase(
      longUrl,
      {
        text: longUrl,
        mediaUrls: undefined,
      },
      extractMarkdownImages,
    );
  });

  it("leaves very long markdown-image candidate lines as text", () => {
    const input = `${"prefix ".repeat(3000)}![x](https://example.com/image.png)`;

    expectParsedMediaOutputCase(
      input,
      {
        text: input,
        mediaUrls: undefined,
      },
      extractMarkdownImages,
    );
  });

  it.each([
    "![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)",
    "![build](https://img.shields.io/github/actions/workflow/status/owner/repo/ci.yml)",
    "![npm](https://badge.fury.io/js/some-package.svg)",
    "![badgen](https://badgen.net/npm/v/some-package)",
    "![CI](https://github.com/owner/repo/actions/workflows/ci.yml/badge.svg)",
    "![flat-badge](https://flat.badgen.net/npm/v/some-package)",
  ] as const)("keeps markdown badge image as text by default: %s", (input) => {
    expectParsedMediaOutputCase(input, {
      text: input,
      mediaUrls: undefined,
    });
  });

  it("keeps surrounding text around inline badge images by default", () => {
    expectParsedMediaOutputCase(
      "tech: ![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white) stack",
      {
        text: "tech: ![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white) stack",
        mediaUrls: undefined,
      },
    );
  });

  it("still extracts markdown images when explicitly enabled", () => {
    expectParsedMediaOutputCase(
      "![badge](https://img.shields.io/badge/status-passing-green)\n![photo](https://example.com/photo.png)",
      {
        mediaUrls: [
          "https://img.shields.io/badge/status-passing-green",
          "https://example.com/photo.png",
        ],
      },
      extractMarkdownImages,
    );
  });

  // ====================================================================
  // Indented code block heuristic protection (Fix A)
  // ====================================================================

  it("does not extract MEDIA: from 4-space indented code block", () => {
    const input =
      "\u4F7F\u7528\u793A\u4F8B\uFF1A\n\n    MEDIA: /tmp/screenshot.png\n\n\u4EE5\u4E0A\u4E3A\u7528\u6CD5\u3002";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe(input);
  });

  it("does not extract MEDIA: from tab-indented code block", () => {
    const input = "\u793A\u4F8B\uFF1A\n\n\tMEDIA: /tmp/file.png\n\n\u8BF4\u660E\u3002";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe(input);
  });

  it("does not extract MEDIA: from multi-line indented code block", () => {
    const input =
      "\u4EE3\u7801\uFF1A\n\n    line1\n    MEDIA: /tmp/test.png\n    line3\n\n\u7ED3\u675F\u3002";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe(input);
  });

  it("does not extract MEDIA: from indented code block with blank lines within", () => {
    const input =
      "\u4EE3\u7801\uFF1A\n\n    block1\n\n    MEDIA: /tmp/file.png\n\n\u7ED3\u675F\u3002";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe(input);
  });

  it("does not treat indented line after paragraph as code block", () => {
    const input = "some text\n    MEDIA: /tmp/real.png";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toEqual(["/tmp/real.png"]);
    expect(result.text).toBe("some text");
  });

  it("does not extract MEDIA: from indented code block immediately after fenced block", () => {
    const input =
      "```\nfenced content\n```\n    MEDIA: /tmp/indented-after-fence.png\n\n\u7ED3\u675F\u3002";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe(input);
  });

  // ====================================================================
  // cleanedText whitespace protection (Fix A+)
  // ====================================================================

  it("preserves indented code block formatting when real MEDIA: is also present", () => {
    const input =
      "MEDIA: /tmp/real-image.png\n\n\u4EE3\u7801\u793A\u4F8B\uFF1A\n\n    MEDIA: /tmp/example.png\n    console.log('hello');";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toEqual(["/tmp/real-image.png"]);
    expect(result.text).toContain("    MEDIA: /tmp/example.png");
    expect(result.text).toContain("    console.log('hello');");
  });

  it("preserves fenced code block content when real MEDIA: is extracted", () => {
    const input = "MEDIA: /tmp/photo.png\n```\n    indented inside fence\n```\nafter";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toEqual(["/tmp/photo.png"]);
    expect(result.text).toContain("    indented inside fence");
  });

  it("preserves tab indentation in code blocks alongside real MEDIA extraction", () => {
    const input = "MEDIA: /tmp/img.png\n\n\u4EE3\u7801\uFF1A\n\n\tconst x = 1;\n\tconst y = 2;";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toEqual(["/tmp/img.png"]);
    expect(result.text).toContain("\tconst x = 1;");
    expect(result.text).toContain("\tconst y = 2;");
  });

  it("collapses blank lines within indented code block when MEDIA is extracted (known limitation)", () => {
    const input = "MEDIA: /tmp/real.png\n\n    block1\n\n    block2";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toEqual(["/tmp/real.png"]);
    expect(result.text).toContain("    block1");
    expect(result.text).toContain("    block2");
    expect(result.text).not.toContain("\n\n");
  });

  // ====================================================================
  // Segments correctness
  // ====================================================================

  it("segments correctly reflect indented code block as text", () => {
    const input = "Before\nMEDIA:https://example.com/a.png\n\n    MEDIA: /tmp/code.png\n\nAfter";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toEqual(["https://example.com/a.png"]);
    const textContent = result.segments
      ?.filter((s) => s.type === "text")
      .map((s) => s.text)
      .join("\n");
    expect(textContent).toContain("    MEDIA: /tmp/code.png");
  });

  // ====================================================================
  // Fence closing with trailing text (Fix C)
  // ====================================================================

  it("does not extract MEDIA: when fence closing has trailing text", () => {
    const input = "```\nMEDIA: /tmp/inside.png\n``` not closed\nMEDIA: /tmp/also-inside.png";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe(input);
  });

  it("extracts MEDIA: after valid fence close with trailing whitespace only", () => {
    const input = "```\nMEDIA: /tmp/inside.png\n```   \nMEDIA: /tmp/outside.png";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toEqual(["/tmp/outside.png"]);
  });

  it("malformed fence + audio_as_voice: tag is stripped regardless (pre-existing behavior)", () => {
    const input = "```\ncode\n``` not closed\n[[audio_as_voice]]\nsome text";
    const result = splitMediaFromOutput(input);
    expect(result.audioAsVoice).toBe(true);
  });

  // ====================================================================
  // Case sensitivity alignment
  // ====================================================================

  it("does not extract lowercase media: directive", () => {
    const input = "media: /tmp/file.png";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe(input);
  });

  // ====================================================================
  // Edge cases
  // ====================================================================

  it("handles document starting with indented MEDIA: line", () => {
    const input = "    MEDIA: /tmp/file.png";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe(input);
  });

  it("handles mixed: real MEDIA + fenced code + indented code in one output", () => {
    const input = [
      "MEDIA: /tmp/real.png",
      "\u89E3\u91CA\uFF1A",
      "```",
      "MEDIA: /tmp/fenced.png",
      "```",
      "",
      "    MEDIA: /tmp/indented.png",
      "",
      "\u5B8C\u6210\u3002",
    ].join("\n");
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toEqual(["/tmp/real.png"]);
    expect(result.text).toContain("MEDIA: /tmp/fenced.png");
    expect(result.text).toContain("    MEDIA: /tmp/indented.png");
    expect(result.text).toContain("\u5B8C\u6210\u3002");
  });

  it("handles audio_as_voice with indented code block", () => {
    const input = "[[audio_as_voice]]\n\n    MEDIA: /tmp/code-example.png\n\n\u8BF4\u660E\u3002";
    const result = splitMediaFromOutput(input);
    expect(result.audioAsVoice).toBe(true);
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toContain("    MEDIA: /tmp/code-example.png");
  });

  it("trims leading whitespace from non-code prose after MEDIA removal", () => {
    const result = splitMediaFromOutput("MEDIA:/tmp/a\n  hello");
    expect(result.text).toBe("hello");
    expect(result.mediaUrls).toEqual(["/tmp/a"]);
  });

  it("trims leading tab from non-code prose after MEDIA removal", () => {
    const result = splitMediaFromOutput("MEDIA:/tmp/a\n\thello");
    expect(result.text).toBe("hello");
    expect(result.mediaUrls).toEqual(["/tmp/a"]);
  });

  it("preserves 4-space code indentation on first line after MEDIA removal", () => {
    const result = splitMediaFromOutput("MEDIA:/tmp/a\n\n    code line");
    expect(result.text).toBe("    code line");
    expect(result.mediaUrls).toEqual(["/tmp/a"]);
  });
});
