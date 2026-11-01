// Media parse tests cover media reference parsing from text and payloads.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { splitMediaFromOutput } from "./parse.js";

type SplitMediaFromOutputOptions = NonNullable<Parameters<typeof splitMediaFromOutput>[1]>;

describe("splitMediaFromOutput", () => {
  function expectParsedMediaOutputCase(
    input: string,
    expected: {
      mediaUrls?: readonly string[];
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
    } else {
      expect(result.mediaUrls).toBeUndefined();
    }
    return result;
  }

  function expectStableAudioAsVoiceDetectionCase(input: string) {
    for (const output of [splitMediaFromOutput(input), splitMediaFromOutput(input)]) {
      expect(output.audioAsVoice).toBe(true);
    }
  }

  function expectAcceptedMediaPathCase(expectedPath: string, input: string) {
    expectOrderedMediaOutputCase(input, [expectedPath]);
  }

  function expectOrderedMediaOutputCase(input: string, mediaUrls: readonly string[]) {
    const result = expectParsedMediaOutputCase(input, { mediaUrls });
    expect(result.segments).toEqual(mediaUrls.map((url) => ({ type: "media", url })));
  }

  function expectRejectedMediaPathCase(input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: undefined });
  }

  function expectUnrecognizedMediaTextCase(input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: undefined, text: input });
  }

  function expectPolicyRejectedMediaUrlCase(input: string) {
    const result = expectParsedMediaOutputCase(input, { mediaUrls: undefined, text: "" });
    expect(result.rejectedMediaCount).toBe(1);
  }

  it.each([
    [
      "/Users/pete/My Files/Project Assets/render final.png",
      "MEDIA:/Users/pete/My Files/Project Assets/render final.png",
    ],
    [
      "/Users/pete/My Files/Project Assets/render final.png",
      'MEDIA:"/Users/pete/My Files/Project Assets/render final.png"',
    ],
    ["/tmp/album.v1/photo.png copy.png", "MEDIA:/tmp/album.v1/photo.png copy.png"],
    ["./screenshots/image.png", "MEDIA:./screenshots/image.png"],
    ["media/inbound/image.png", "MEDIA:media/inbound/image.png"],
    ["media://inbound/image.png", "MEDIA:media://inbound/image.png"],
    ["./screenshot.png", " MEDIA:./screenshot.png"],
    ["./screenshot.png", "  MEDIA:./screenshot.png"],
    ["./screenshot.png", "   MEDIA:./screenshot.png"],
    ["~/Pictures/My File.png", "MEDIA:~/Pictures/My File.png"],
    ["C:\\Users\\pete\\Pictures\\snap.png", "MEDIA:C:\\Users\\pete\\Pictures\\snap.png"],
    [
      "C:\\Users\\First  Last\\workspace\\shot.png",
      "MEDIA:C:\\Users\\First  Last\\workspace\\shot.png",
    ],
    [
      "\\\\server\\My Files\\Project Assets\\render final.png",
      "MEDIA:\\\\server\\My Files\\Project Assets\\render final.png",
    ],
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
    "media://outbound/image.png",
    "media://inbound/nested%2Fimage.png",
    "media://inbound/%00.png",
    "media://inbound/image.png?token=value",
    "media://inbound/",
  ])("does not extract an invalid inbound URI: %s", (source) => {
    expectPolicyRejectedMediaUrlCase(`MEDIA:${source}`);
  });

  it.each([",", '"', "'", "\\", ")", "}", "]", "`"])(
    "preserves quoted URL suffix %s while cleaning ordinary unquoted punctuation",
    (suffix) => {
      const base = "https://example.com/video.mp4?token=ends";
      const mediaUrl = `${base}${suffix}`;
      for (const quote of ['"', "'"]) {
        expectAcceptedMediaPathCase(mediaUrl, `MEDIA:${quote}${mediaUrl}${quote}`);
      }
      expectAcceptedMediaPathCase(base, `MEDIA:${mediaUrl}`);
    },
  );

  it("does not shorten a rejected quoted URL into an accepted media reference", () => {
    const prefix = "https://example.com/video.mp4?token=";
    const mediaUrl = `${prefix}${"a".repeat(4096 - prefix.length)},`;
    expectPolicyRejectedMediaUrlCase(`MEDIA:"${mediaUrl}"`);
  });

  const nativeFilePath = path.resolve("media", "café 100% image.png");
  const nativeFileUrl = pathToFileURL(nativeFilePath).href;
  it.each([
    nativeFileUrl,
    nativeFileUrl.replace(/^file:\/\//u, "FILE:"),
    nativeFileUrl.replace(/^file:/u, "FILE:"),
    nativeFileUrl.replace(/^file:\/\//u, "file://localhost"),
    nativeFileUrl.replace(/%20/gu, " "),
  ])("preserves file URLs for native media loading: %s", (fileUrl) => {
    expectAcceptedMediaPathCase(fileUrl, `MEDIA:${fileUrl}`);
  });

  it.each([nativeFileUrl, nativeFilePath])("keeps file URL siblings separate from %s", (first) => {
    const secondPath = path.resolve("media", "second image.png");
    expectParsedMediaOutputCase(`MEDIA:${first} ${pathToFileURL(secondPath).href}`, {
      mediaUrls: [first, pathToFileURL(secondPath).href],
    });
  });

  it.each([
    [
      "quoted bare filename with spaces",
      'Generated image\nMEDIA:"render final.png"',
      ["render final.png"],
    ],
    ["unquoted bare filename with spaces", "MEDIA:render final.png", ["render final.png"]],
    [
      "bare filenames surrounding remote media",
      "MEDIA:image.png\nMEDIA:https://example.com/remote.png\nMEDIA:voice.ogg",
      ["image.png", "https://example.com/remote.png", "voice.ogg"],
    ],
  ] as const)(
    "projects every accepted media URL into ordered segments: %s",
    (_name, input, urls) => {
      const result = splitMediaFromOutput(input);

      expect(result.mediaUrls).toEqual(urls);
      expect(result.segments?.filter((segment) => segment.type === "media")).toEqual(
        urls.map((url) => ({ type: "media", url })),
      );
    },
  );

  it.each([
    ["MEDIA:/tmp/a.png /tmp/b.png", ["/tmp/a.png", "/tmp/b.png"]],
    [
      'MEDIA:"/tmp/first image.png" "/tmp/second image.png"',
      ["/tmp/first image.png", "/tmp/second image.png"],
    ],
    [
      "MEDIA:'/tmp/first image.png' '/tmp/second image.png'",
      ["/tmp/first image.png", "/tmp/second image.png"],
    ],
    [
      "MEDIA:`/tmp/first image.png` `/tmp/second image.png`",
      ["/tmp/first image.png", "/tmp/second image.png"],
    ],
    [
      'MEDIA:"/tmp/project /first image.png" "/tmp/second.png"',
      ["/tmp/project /first image.png", "/tmp/second.png"],
    ],
    ['MEDIA:"/tmp/ends" "/tmp/second.png"', ["/tmp/ends", "/tmp/second.png"]],
    ["MEDIA:media/a.png media/b.png", ["media/a.png", "media/b.png"]],
    ["MEDIA:/tmp/a.png media/b.png", ["/tmp/a.png", "media/b.png"]],
    ["MEDIA:./a.png ./b.png", ["./a.png", "./b.png"]],
    ["MEDIA:/tmp/a.png https://example.com/b.png", ["/tmp/a.png", "https://example.com/b.png"]],
    [
      "MEDIA:C:\\Users\\First Last\\workspace\\shot.png D:\\Other User\\second.png",
      ["C:\\Users\\First Last\\workspace\\shot.png", "D:\\Other User\\second.png"],
    ],
    [
      "MEDIA:C:\\Users\\First Last\\workspace\\shot.png media/second.png",
      ["C:\\Users\\First Last\\workspace\\shot.png", "media/second.png"],
    ],
    [
      "MEDIA:/tmp/project screenshots/shot.png media\\second.png",
      ["/tmp/project screenshots/shot.png", "media\\second.png"],
    ],
    ["MEDIA:C:\\Users\\First Last\\..\\secret.png D:\\safe\\second.png", ["D:\\safe\\second.png"]],
    ["MEDIA:/tmp/project screenshots/../../.env /tmp/safe/second.png", ["/tmp/safe/second.png"]],
  ] as const)("keeps separate media items on one directive line: %s", (input, mediaUrls) => {
    expectOrderedMediaOutputCase(input, mediaUrls);
  });

  it.each([
    // A backtick wrapper does not turn a whitespace-separated list into one filename.
    ["MEDIA:`/tmp/a.png /tmp/b.png`", ["/tmp/a.png", "/tmp/b.png"]],
    [
      "MEDIA:`/tmp/first image.png /tmp/second image.png`",
      ["/tmp/first image.png", "/tmp/second image.png"],
    ],
  ] as const)("reads a backtick-wrapped line as main reads it: %s", (input, mediaUrls) => {
    expectParsedMediaOutputCase(input, { mediaUrls: [...mediaUrls] });
  });

  it.each([
    ['MEDIA:["/tmp/a.png","/tmp/b.png"]', ["/tmp/a.png", "/tmp/b.png"]],
    ['MEDIA: ["/tmp/a.png", "/tmp/b.png"]', ["/tmp/a.png", "/tmp/b.png"]],
    ['MEDIA:["/tmp/a.png","/tmp/b.png","/tmp/c.png"]', ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"]],
    ['MEDIA:["first.png","second.png"]', ["first.png", "second.png"]],
    [
      'MEDIA:["/tmp/first image.png","/tmp/second image.png"]',
      ["/tmp/first image.png", "/tmp/second image.png"],
    ],
    ['MEDIA:["/tmp/render,final.png","/tmp/b.png"]', ["/tmp/render,final.png", "/tmp/b.png"]],
    ['MEDIA:["/tmp/a.png"]', ["/tmp/a.png"]],
  ] as const)("attaches every reference a serialized JSON array states: %s", (input, mediaUrls) => {
    // Compact and spaced JSON arrays must attach every member.
    expectParsedMediaOutputCase(input, { mediaUrls: [...mediaUrls] });
  });

  it("separates every quoted member of a list, bare filenames included", () => {
    // Quote pairs delimit bare filenames; they must never be welded to adjacent paths.
    for (const [input, mediaUrls] of [
      ['MEDIA:"/tmp/first.png" "second.png"', ["/tmp/first.png", "second.png"]],
      ['MEDIA:"second.png" "/tmp/first.png"', ["second.png", "/tmp/first.png"]],
      ['MEDIA:"first.png" "second.png"', ["first.png", "second.png"]],
      ["MEDIA:'/tmp/first.png' 'second.png'", ["/tmp/first.png", "second.png"]],
      ['MEDIA:"/tmp/a.png" "b.png" "c.png"', ["/tmp/a.png", "b.png", "c.png"]],
    ] as const) {
      expectParsedMediaOutputCase(input, { mediaUrls: [...mediaUrls] });
    }
    // The same two references written on two lines, which is the contract those lists have to match.
    expectParsedMediaOutputCase('MEDIA:"/tmp/first.png"\nMEDIA:"second.png"', {
      mediaUrls: ["/tmp/first.png", "second.png"],
    });
    // A member that is not a reference of its own stays visible text rather than joining its neighbour.
    expectParsedMediaOutputCase('MEDIA:"/tmp/first.png" "second"', {
      mediaUrls: ["/tmp/first.png"],
      text: '"second"',
    });
  });

  it("separates quoted references that a comma divides", () => {
    // A comma between quoted references separates attachments just as it does for bare paths.
    expectParsedMediaOutputCase("MEDIA:/tmp/first.png, /tmp/second.png", {
      mediaUrls: ["/tmp/first.png", "/tmp/second.png"],
    });
    for (const [input, mediaUrls] of [
      [
        'MEDIA:"/tmp/first image.png", "/tmp/second image.png"',
        ["/tmp/first image.png", "/tmp/second image.png"],
      ],
      ['MEDIA:"/tmp/a.png","/tmp/b.png"', ["/tmp/a.png", "/tmp/b.png"]],
      ['MEDIA:"/tmp/first.png", "second.png"', ["/tmp/first.png", "second.png"]],
      ["MEDIA:'/tmp/a.png', '/tmp/b.png'", ["/tmp/a.png", "/tmp/b.png"]],
      ['MEDIA:"/tmp/a.png", "b.png", "c.png"', ["/tmp/a.png", "b.png", "c.png"]],
    ] as const) {
      expectParsedMediaOutputCase(input, { mediaUrls: [...mediaUrls] });
    }
    // Non-reference members remain visible text.
    expectParsedMediaOutputCase('MEDIA:"/tmp/first.png", "second"', {
      mediaUrls: ["/tmp/first.png"],
      text: '"second"',
    });
    // A comma inside one quoted reference stays part of its value, not a separator.
    expectAcceptedMediaPathCase("/tmp/Hello, World.png", 'MEDIA:"/tmp/Hello, World.png"');
    // Unquoted prose after a comma does not form a reference list.
    expectParsedMediaOutputCase('MEDIA:"/tmp/first.png", the picture above', {
      mediaUrls: ["/tmp/first.png"],
    });
    // An apostrophe before a comma can belong to the directory name, not a closing delimiter.
    expectParsedMediaOutputCase("MEDIA:'/tmp/Students', 2024/album.png' '/tmp/second.png'", {
      mediaUrls: ["/tmp/Students', 2024/album.png", "/tmp/second.png"],
    });
    // The comma after the closing delimiter does separate a quoted sibling.
    expectParsedMediaOutputCase("MEDIA:'/tmp/Students', 2024/album.png', '/tmp/second.png'", {
      mediaUrls: ["/tmp/Students', 2024/album.png", "/tmp/second.png"],
    });
    // One reference needs no following quote, so an apostrophe before a comma stays inside its value.
    expectAcceptedMediaPathCase(
      "/tmp/Students', 2024/album.png",
      "MEDIA:'/tmp/Students', 2024/album.png'",
    );
  });

  it.each([
    'MEDIA:"first.png," "second.png,"',
    "MEDIA:'first.png,' 'second.png,'",
    'MEDIA:"first" "second.png,"',
  ] as const)("keeps an all-rejected quoted list as text: %s", (input) => {
    // Rejected list members must not be welded into a synthetic filename by whole-payload fallback.
    expectUnrecognizedMediaTextCase(input);
  });

  it("keeps a quoted list whose every member is rejected as text", () => {
    // Also keep lists whose whole payload cannot resemble a filename.
    for (const input of [
      'MEDIA:"first.png," "second"',
      'MEDIA:"first" "second"',
      "MEDIA:'first.png,' 'second'",
    ] as const) {
      expectUnrecognizedMediaTextCase(input);
    }
    // Accepted members remain separate from rejected text.
    expectParsedMediaOutputCase('MEDIA:"/tmp/first.png" "second,"', {
      mediaUrls: ["/tmp/first.png"],
      text: '"second,"',
    });
    expectParsedMediaOutputCase('MEDIA:"first.png" "second.png,"', {
      mediaUrls: ["first.png"],
      text: '"second.png,"',
    });
    // Policy-rejected paths and URLs are removed without promoting the remaining words to media.
    expectRejectedMediaPathCase('MEDIA:"../../a" "../../b"');
    expectPolicyRejectedMediaUrlCase('MEDIA:"http://evil.example/x.png" "y.png,"');
    expectPolicyRejectedMediaUrlCase('MEDIA:"http://evil.example/x.png" "y"');
  });

  it("keeps a quoted reference whole when its own value contains that quote", () => {
    // Inner quotes belong to a signed URL and must not truncate it or leak its suffix into text.
    for (const [input, expected] of [
      [
        "MEDIA:'https://example.com/video.mp4?token=it's' /tmp/second.png",
        ["https://example.com/video.mp4?token=it's", "/tmp/second.png"],
      ],
      [
        'MEDIA:"https://example.com/video.mp4?token=it\'s" /tmp/second.png',
        ["https://example.com/video.mp4?token=it's", "/tmp/second.png"],
      ],
      [
        "MEDIA:'https://example.com/video.mp4?token=it'\\''s' /tmp/second.png",
        ["https://example.com/video.mp4?token=it'\\''s", "/tmp/second.png"],
      ],
      // Quoting the sibling must preserve the same boundary.
      [
        "MEDIA:'https://example.com/video.mp4?token=it's' '/tmp/second.png'",
        ["https://example.com/video.mp4?token=it's", "/tmp/second.png"],
      ],
      [
        'MEDIA:"https://example.com/video.mp4?token=it\'s" "/tmp/second.png"',
        ["https://example.com/video.mp4?token=it's", "/tmp/second.png"],
      ],
    ] as const) {
      expectOrderedMediaOutputCase(input, expected);
    }
  });

  it("keeps a quoted reference whole when its own value holds that quote and whitespace", () => {
    // Inner quotes and filename whitespace can coexist within one reference.
    for (const [input, expected] of [
      ["MEDIA:'/tmp/team's.v1 final/image.png'", ["/tmp/team's.v1 final/image.png"]],
      [
        "MEDIA:'/tmp/team's.v1 final/image.png' '/tmp/second.png'",
        ["/tmp/team's.v1 final/image.png", "/tmp/second.png"],
      ],
    ] as const) {
      expectOrderedMediaOutputCase(input, expected);
    }
  });

  it.each([
    // Whitespace after an inner quote does not necessarily end the enclosing filename.
    ["MEDIA:'/tmp/parents' photos/photo.png'", ["/tmp/parents' photos/photo.png"]],
    ['MEDIA:"/tmp/parents" photos/photo.png"', ['/tmp/parents" photos/photo.png']],
    // Preserve the existing whole-payload interpretation of this ambiguous remainder.
    [
      "MEDIA:'/tmp/parents' photos/photo.png' '/tmp/second.png'",
      ["/tmp/parents' photos/photo.png' '/tmp/second.png"],
    ],
  ] as const)(
    "keeps an inner quote followed by whitespace inside one quoted reference: %s",
    (input, mediaUrls) => {
      expectOrderedMediaOutputCase(input, mediaUrls);
    },
  );

  it.each([
    // Quotes inside an unquoted path are filename text rather than reference delimiters.
    ["MEDIA:/tmp/album 'best' photos/image.png", ["/tmp/album 'best' photos/image.png"]],
    ['MEDIA:/tmp/album "best" photos/image.png', ['/tmp/album "best" photos/image.png']],
    [
      "MEDIA:/tmp/album 'best' photos/image.png /tmp/second.png",
      ["/tmp/album 'best' photos/image.png", "/tmp/second.png"],
    ],
    // A slash inside the quoted fragment must not make it an independent attachment.
    ["MEDIA:/tmp/album 'best/photos' final.png", ["/tmp/album 'best/photos' final.png"]],
    ['MEDIA:/tmp/album "best/photos" final.png', ['/tmp/album "best/photos" final.png']],
    [
      "MEDIA:/tmp/album 'best/photos' final.png /tmp/second.png",
      ["/tmp/album 'best/photos' final.png", "/tmp/second.png"],
    ],
    // A quoted sibling stays separate even when a filename's inner quote ends beside a slash.
    [
      "MEDIA:/tmp/album 'best'/final.png '/tmp/second.png'",
      ["/tmp/album 'best'/final.png", "/tmp/second.png"],
    ],
    [
      "MEDIA:/tmp/album 'best' photos/image.png '/tmp/second.png'",
      ["/tmp/album 'best' photos/image.png", "/tmp/second.png"],
    ],
  ] as const)("keeps a quoted fragment inside one unquoted reference: %s", (input, mediaUrls) => {
    expectOrderedMediaOutputCase(input, mediaUrls);
  });

  it("keeps a quoted relative reference separate from the quoted reference before it", () => {
    expectOrderedMediaOutputCase('MEDIA:"/tmp/first image.png" "media/second image.png"', [
      "/tmp/first image.png",
      "media/second image.png",
    ]);
  });

  it("keeps a trailing quote pair inside one quoted reference", () => {
    // Adjacent trailing quotes are part of the signed URL, not an empty sibling reference.
    expectParsedMediaOutputCase('MEDIA:"https://example.com/video.mp4?token=ends"""', {
      mediaUrls: ['https://example.com/video.mp4?token=ends""'],
    });
  });

  it.each([
    // Unclosed quotes do not delimit a list; retain normal cleanup or literal-text behavior.
    ["MEDIA:'/tmp/photo.png", ["/tmp/photo.png"]],
    ['MEDIA:"/tmp/photo.png', ["/tmp/photo.png"]],
    ["MEDIA:`/tmp/photo.png", ["/tmp/photo.png"]],
    ["MEDIA:/tmp/photo.png'", ["/tmp/photo.png"]],
    // An unclosed quote must not fuse two references that whitespace already separated.
    ["MEDIA:/tmp/photo.png '/tmp/second.png", ["/tmp/photo.png", "/tmp/second.png"]],
    // Ambiguous unmatched delimiters retain the whole-payload interpretation.
    ["MEDIA:'/tmp/first.png' \"/tmp/second.png'", ["/tmp/first.png' \"/tmp/second.png"]],
    // A single quoted value is one reference even when the quote pair wraps leading whitespace.
    ["MEDIA:' /tmp/photo.png'", ["/tmp/photo.png"]],
    // A stray trailing quote must not split an inner filename fragment.
    ["MEDIA:/tmp/album 'best/photos' final.png'", ["/tmp/album 'best/photos' final.png"]],
  ] as const)("reads a payload with an unclosed quote as main reads it: %s", (input, mediaUrls) => {
    expectParsedMediaOutputCase(input, { mediaUrls });
  });

  it.each(["MEDIA:'", "MEDIA:''", "MEDIA:'' ''", "MEDIA:'a 'a 'a"])(
    "keeps a payload whose quotes never pair as text: %s",
    (input) => {
      expectParsedMediaOutputCase(input, { mediaUrls: undefined, text: input });
    },
  );

  it("keeps a quote-heavy payload without closing delimiters as text", () => {
    const payload = "'a ".repeat(32_000).trimEnd();
    expectParsedMediaOutputCase(`MEDIA:${payload}`, {
      mediaUrls: undefined,
      text: `MEDIA:${payload}`,
    });
  });

  it("preserves quoted punctuation when a reference shares the line with another one", () => {
    // Splitting siblings must preserve signed URL punctuation just as single-reference parsing does.
    const base = "https://example.com/video.mp4?token=ends";
    for (const suffix of [",", ")", "]", "\\"]) {
      const signed = `${base}${suffix}`;
      for (const quote of ['"', "'"]) {
        expectParsedMediaOutputCase(`MEDIA:${quote}${signed}${quote} /tmp/second.png`, {
          mediaUrls: [signed, "/tmp/second.png"],
        });
      }
    }
    expectParsedMediaOutputCase('MEDIA:"/tmp/first image.png," "/tmp/second.png"', {
      mediaUrls: ["/tmp/first image.png,", "/tmp/second.png"],
    });
  });

  it.each([
    "MEDIA:../../../etc/passwd",
    "MEDIA:../../.env",
    'MEDIA:"../../.env)"',
    "MEDIA:~user/Pictures/My File.png",
    "MEDIA:~/Pictures/../../.ssh/id_rsa",
    "MEDIA:./foo/../../../etc/shadow",
    "MEDIA:C:\\Users\\First Last\\..\\secret.png",
    "MEDIA:/tmp/project screenshots/../../.env",
    "MEDIA:file:///tmp/../secret.png",
  ] as const)("rejects traversal and unsupported home-dir path: %s", (input) => {
    expectRejectedMediaPathCase(input);
  });

  it("does not absorb an unsafe remote URL into a spaced local media path", () => {
    expectParsedMediaOutputCase(
      "MEDIA:C:\\Users\\First Last\\workspace\\shot.png https://127.0.0.1/secret.png",
      {
        mediaUrls: ["C:\\Users\\First Last\\workspace\\shot.png"],
        text: "",
      },
    );
  });

  it.each([
    "MEDIA:http://example.com/a.png",
    'MEDIA:"http://example.com/a.png)"',
    "MEDIA:https://intranet/a.png",
    "MEDIA:https://printer/a.png",
    "MEDIA:https://localhost/a.png",
    "MEDIA:https://localhost../a.png",
    "MEDIA:https://127.0.0.1/a.png",
    'MEDIA:"https://127.0.0.1/a.png)"',
    "MEDIA:https://127.0.0.1../a.png",
    "MEDIA:https://169.254.169.254/latest/meta-data",
    'MEDIA:"https://169.254.169.254/a.png)"',
    "MEDIA:https://[::1]/a.png",
    "MEDIA:https://[fe80::1]/a.png",
    "MEDIA:https://[fd00::1]/a.png",
    "MEDIA:https://[fd00:ec2::254]/a.png",
    "MEDIA:https://[::ffff:127.0.0.1]/a.png",
    "MEDIA:https://[64:ff9b::169.254.169.254]/a.png",
    "MEDIA:https://metadata.google.internal/a.png",
    "MEDIA:https://metadata.google.internal../a.png",
    "MEDIA:https://example..com/a.png",
    "MEDIA:https://media.local/a.png",
    "MEDIA:https://user:synthetic-password@example.com/a.png",
  ] as const)("rejects unsafe remote media URL: %s", (input) => {
    expectPolicyRejectedMediaUrlCase(input);
  });

  it.each(["https://[2606:4700::1111]/a.png", "https://[2001:4860:4860::8888]/a.png"] as const)(
    "accepts public IPv6 remote media URL: %s",
    (url) => {
      expectParsedMediaOutputCase(`MEDIA:${url}`, { mediaUrls: [url], text: "" });
    },
  );

  it.each([
    {
      name: "detects audio_as_voice tag and strips it",
      input: "Hello [[audio_as_voice]] world",
      expected: { audioAsVoice: true, text: "Hello world" },
    },
    {
      name: "extracts an indented paragraph continuation outside a code block",
      input: "Caption\n    MEDIA:https://example.com/a.png",
      expected: { text: "Caption", mediaUrls: ["https://example.com/a.png"] },
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

  it("preserves paragraph breaks in ordered media text segments", () => {
    const result = splitMediaFromOutput(
      "First paragraph\n\nSecond paragraph\nMEDIA:https://example.com/a.png",
    );

    expect(result.segments).toEqual([
      { type: "text", text: "First paragraph\n\nSecond paragraph" },
      { type: "media", url: "https://example.com/a.png" },
    ]);
  });

  it.each([
    ["before", "First paragraph\n\nMEDIA:https://example.com/a.png\nSecond paragraph"],
    ["after", "First paragraph\nMEDIA:https://example.com/a.png\n\nSecond paragraph"],
    ["around", "First paragraph\n\nMEDIA:https://example.com/a.png\n\nSecond paragraph"],
    ["with spaces", "First paragraph\n \nMEDIA:https://example.com/a.png\n  \nSecond paragraph"],
    ["with tabs", "First paragraph\n\t\nMEDIA:https://example.com/a.png\n\t\nSecond paragraph"],
  ])("preserves a paragraph separator %s an attachment", (_placement, input) => {
    const result = splitMediaFromOutput(input);

    expect(result.segments).toEqual([
      { type: "text", text: "First paragraph\n" },
      { type: "media", url: "https://example.com/a.png" },
      { type: "text", text: "Second paragraph" },
    ]);
  });

  it.each(["    ", "\t"])("does not emit a whitespace-only media caption: %j", (whitespace) => {
    const result = splitMediaFromOutput(`${whitespace}\nMEDIA:https://example.com/a.png`);

    expect(result.text).toBe("");
    expect(result.segments).toEqual([{ type: "media", url: "https://example.com/a.png" }]);
  });

  it("drops separator-only lines before the caption after extracting leading media", () => {
    expectParsedMediaOutputCase("MEDIA:https://example.com/a.png\n\nCaption", {
      text: "Caption",
      mediaUrls: ["https://example.com/a.png"],
    });
  });

  it.each([
    {
      name: "a marker carrying trailing text",
      separator: "\n",
      lines: ["```python", "value = 'a  b'", "``` not a close", "other = 'c  d'", "```"],
    },
    {
      name: "an unclosed fence",
      separator: "\n",
      lines: ["```python", "value = 'a  b'", "other = 'c  d'"],
    },
    {
      name: "an indented closing fence",
      separator: "\n",
      lines: ["```python", "value = 'a  b'", "   ```"],
    },
    {
      name: "a four-space indented block",
      separator: "\n\n",
      lines: ["    MEDIA:https://example.com/literal.png", "    literal = 'a  b'"],
    },
    {
      name: "an indented block inside a list",
      separator: "\n\n",
      lines: ["- Example", "", "      MEDIA:https://example.com/literal.png"],
    },
    {
      name: "a tab-indented block",
      separator: "\n\n",
      lines: ["\tMEDIA:https://example.com/literal.png", "\tliteral = 'a  b'"],
    },
  ])("preserves canonical code examples with $name", ({ lines, separator }) => {
    const code = lines.join("\n");

    expectParsedMediaOutputCase(`MEDIA:https://example.com/a.png${separator}${code}`, {
      text: code,
      mediaUrls: ["https://example.com/a.png"],
    });
    expectParsedMediaOutputCase(
      `[[audio_as_voice]]\nMEDIA:https://example.com/a.png${separator}${code}`,
      {
        text: code,
        mediaUrls: ["https://example.com/a.png"],
        audioAsVoice: true,
      },
    );
  });

  const extractMarkdownImages = { extractMarkdownImages: true } as const;
  const formattedMediaReply = [
    "Here is the code.",
    "",
    "```python",
    "def summarize(rows):",
    "    totals = {}",
    "    for row in rows:",
    "        totals[row] = 1",
    "    return totals",
    "```",
    "",
    "The attachment is ready.",
  ].join("\n");

  it.each([
    {
      name: "a MEDIA directive",
      input: `${formattedMediaReply}\n\nMEDIA:https://example.com/config.png`,
      mediaUrl: "https://example.com/config.png",
      options: undefined,
      audioAsVoice: undefined,
    },
    {
      name: "an extracted Markdown image",
      input: `${formattedMediaReply}\n\n![chart](https://example.com/chart.png)`,
      mediaUrl: "https://example.com/chart.png",
      options: extractMarkdownImages,
      audioAsVoice: undefined,
    },
    {
      name: "an audio directive and media",
      input: `[[audio_as_voice]]\n${formattedMediaReply}\n\nMEDIA:https://example.com/recording.ogg`,
      mediaUrl: "https://example.com/recording.ogg",
      options: undefined,
      audioAsVoice: true,
    },
  ])("preserves code indentation and paragraph breaks with $name", (testCase) => {
    expectParsedMediaOutputCase(
      testCase.input,
      {
        text: formattedMediaReply,
        mediaUrls: [testCase.mediaUrl],
        ...(testCase.audioAsVoice ? { audioAsVoice: true } : {}),
      },
      testCase.options,
    );
  });

  it("keeps markdown image urls as text by default", () => {
    const input = "Caption\n\n![chart](https://example.com/chart.png)";
    expectParsedMediaOutputCase(input, {
      text: input,
      mediaUrls: undefined,
    });
  });

  it.each([
    [
      "paragraph captions",
      "Caption\n\n![chart](https://example.com/chart.png)",
      "Caption",
      ["https://example.com/chart.png"],
    ],
    [
      "inline captions",
      "Look ![chart](https://example.com/chart.png) now",
      "Look now",
      ["https://example.com/chart.png"],
    ],
    [
      "blockquote inline semantics",
      '> <span title="![chart](https://example.com/chart.png)"\n> caption',
      '> <span title=""\n> caption',
      ["https://example.com/chart.png"],
    ],
    [
      "an image after an identical code example",
      "> `![chart](https://example.com/chart.png)` ![chart](https://example.com/chart.png)",
      "> `![chart](https://example.com/chart.png)`",
      ["https://example.com/chart.png"],
    ],
    [
      "multiple image order",
      "Before\n![one](https://example.com/one.png)\nMiddle\n![two](https://example.com/two.png)\nAfter",
      "Before\nMiddle\nAfter",
      ["https://example.com/one.png", "https://example.com/two.png"],
    ],
    [
      "title suffixes",
      'Caption ![chart](https://example.com/chart.png "Quarterly chart")',
      "Caption",
      ["https://example.com/chart.png"],
    ],
    [
      "balanced parentheses",
      "Chart ![img](https://example.com/a_(1).png) now",
      "Chart now",
      ["https://example.com/a_(1).png"],
    ],
    [
      "balanced destination punctuation",
      "![chart](https://example.com/render?label=(chart))",
      "",
      ["https://example.com/render?label=(chart)"],
    ],
  ] as const)("extracts Markdown images with %s", (_name, input, text, mediaUrls) => {
    expectParsedMediaOutputCase(input, { text, mediaUrls }, extractMarkdownImages);
  });

  it.each([undefined, false, true])(
    "extracts only exact allowlisted Markdown image targets (extractMarkdownImages=%s)",
    (extractImages) => {
      expectParsedMediaOutputCase(
        "Before ![selected](/tmp/selected.png) after ![remote](https://example.com/remote.png)",
        {
          text: "Before after ![remote](https://example.com/remote.png)",
          mediaUrls: ["file:///tmp/selected.png"],
        },
        {
          extractMarkdownImages: extractImages,
          markdownImageAllowlist: ["file:///tmp/selected.png"],
        },
      );
    },
  );

  it.each([undefined, false, true])(
    "keeps images literal for an empty allowlist (extractMarkdownImages=%s)",
    (extractImages) => {
      const input = "Before ![chart](https://example.com/chart.png) after";
      expect(
        splitMediaFromOutput(input, {
          extractMarkdownImages: extractImages,
          markdownImageAllowlist: [],
        }),
      ).toEqual({ text: input, segments: [{ type: "text", text: input }] });
    },
  );

  it("selects an explicitly allowlisted file URL", () => {
    const url = "file:///tmp/selected.png";
    expectParsedMediaOutputCase(
      `Before ![selected](${url}) after`,
      { text: "Before after", mediaUrls: [url] },
      { markdownImageAllowlist: [url] },
    );
  });

  it("does not recursively parse nested image labels", () => {
    const nested = "![".repeat(4_000) + "x" + "](x)".repeat(4_000);
    const url = "https://example.com/chart.png";
    const startedAt = performance.now();
    expectParsedMediaOutputCase(
      `${nested}\n![chart](${url})`,
      { text: nested, mediaUrls: [url] },
      extractMarkdownImages,
    );
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it("keeps nested labels within reference images literal", () => {
    const input =
      "![![nested](https://example.com/nested.png)][outer]\n\n[outer]: https://example.com/outer.png";
    expectParsedMediaOutputCase(
      input,
      { text: input, mediaUrls: undefined },
      extractMarkdownImages,
    );
  });

  it.each(["\n", "\r\n", "\r"])(
    "extracts multiline Markdown images across %j line endings",
    (newline) => {
      const url = "https://example.com/chart.png";
      for (const image of [
        `![chart](${newline}${url}${newline})`,
        `![quarterly${newline}chart](${url})`,
        `![chart](${url}${newline}"Quarterly chart")`,
      ]) {
        const input = `Before${newline}${image}${newline}After`;
        expect(splitMediaFromOutput(input, extractMarkdownImages)).toEqual(
          splitMediaFromOutput(
            `Before${newline}![chart](${url})${newline}After`,
            extractMarkdownImages,
          ),
        );
      }
    },
  );

  it.each([false, true])(
    "preserves multiline image captions and media order (whitespace=%s)",
    (preserveTrailingWhitespace) => {
      const url = "https://example.com/chart.png";
      const options = { ...extractMarkdownImages, preserveTrailingWhitespace };
      expect(
        splitMediaFromOutput(
          `Before ![chart](\n${url}\n) after\nMEDIA:/tmp/next.png\nTail`,
          options,
        ),
      ).toEqual(
        splitMediaFromOutput(`Before ![chart](${url}) after\nMEDIA:/tmp/next.png\nTail`, options),
      );
    },
  );

  it("applies the image allowlist to complete multiline spans", () => {
    const selected = "file:///tmp/selected.png";
    const unselected = "![other](\nhttps://example.com/other.png\n)";
    expect(
      splitMediaFromOutput(`![selected](\n${selected}\n)\n${unselected}`, {
        markdownImageAllowlist: [selected],
        preserveTrailingWhitespace: true,
      }),
    ).toMatchObject({ text: unselected, mediaUrls: [selected] });
  });

  it.each([
    ["inline code", "Use `![chart](https://example.com/chart.png)` as an example."],
    ["escaped syntax", "\\![chart](https://example.com/chart.png)"],
    ["indented code", "    ![chart](https://example.com/chart.png)"],
    ["multiline inline code", "``example\n![chart](https://example.com/chart.png)\n``"],
  ])("keeps Markdown image syntax literal in %s", (_name, input) => {
    expectParsedMediaOutputCase(
      input,
      { text: input, mediaUrls: undefined },
      extractMarkdownImages,
    );
  });

  it.each(["\n", "\r\n", "\r"])("keeps image offsets across %j line endings", (newline) => {
    const url = "https://example.com/chart.png";
    expectParsedMediaOutputCase(
      `before${newline}${newline}![chart](${url})`,
      { text: "before", mediaUrls: [url] },
      extractMarkdownImages,
    );
  });

  it.each(["\n", "\r\n", "\r"])("separates MEDIA directives across %j line endings", (newline) => {
    const result = splitMediaFromOutput(
      `MEDIA:/tmp/first.png${newline}MEDIA:/tmp/second.png${newline}Caption${newline}End`,
    );
    expect(result.mediaUrls).toEqual(["/tmp/first.png", "/tmp/second.png"]);
    expect(result.text).toBe(`Caption${newline}End`);
    expect(result.segments).toEqual([
      { type: "media", url: "/tmp/first.png" },
      { type: "media", url: "/tmp/second.png" },
      { type: "text", text: `Caption${newline}End` },
    ]);
  });

  it.each(["\n", "\r\n", "\r"])("keeps fenced MEDIA literal across %j line endings", (newline) => {
    const code = ["```txt", "MEDIA:/tmp/literal.png", "  value  ", "```"].join(newline);
    const result = splitMediaFromOutput(`${code}${newline}MEDIA:/tmp/real.png${newline}`, {
      preserveTrailingWhitespace: true,
    });
    expect(result.mediaUrls).toEqual(["/tmp/real.png"]);
    expect(result.text).toBe(`${code}${newline}`);
    expect(result.segments).toEqual([
      { type: "text", text: `${code}${newline}` },
      { type: "media", url: "/tmp/real.png" },
    ]);
  });

  it("keeps mixed source separators around MEDIA directives", () => {
    const caption = "Caption\r\n```txt\nMEDIA:/tmp/literal.png\r  value  \r\n```";
    const result = splitMediaFromOutput(`MEDIA:/tmp/real.png\r${caption}`, {
      preserveTrailingWhitespace: true,
    });
    expect(result.mediaUrls).toEqual(["/tmp/real.png"]);
    expect(result.text).toBe(caption);
    expect(result.segments).toEqual([
      { type: "media", url: "/tmp/real.png" },
      { type: "text", text: caption },
    ]);
  });

  it.each([
    ["\n", "\r"],
    ["\n", "\r\n"],
    ["\r", "\n"],
    ["\r", "\r\n"],
    ["\r\n", "\n"],
    ["\r\n", "\r"],
  ])(
    "keeps the caption separator %j before a removed MEDIA line ending in %j",
    (captionEnd, mediaEnd) => {
      const result = splitMediaFromOutput(`Caption${captionEnd}MEDIA:/tmp/real.png${mediaEnd}`, {
        preserveTrailingWhitespace: true,
      });
      expect(result.mediaUrls).toEqual(["/tmp/real.png"]);
      expect(result.text).toBe(`Caption${captionEnd}`);
      expect(result.segments).toEqual([
        { type: "text", text: `Caption${captionEnd}` },
        { type: "media", url: "/tmp/real.png" },
      ]);

      const stripped = splitMediaFromOutput(
        `MEDIA:/tmp/real.png\nCaption${captionEnd}MEDIA:../blocked.png${mediaEnd}Tail`,
        { preserveTrailingWhitespace: true },
      );
      expect(stripped.mediaUrls).toEqual(["/tmp/real.png"]);
      expect(stripped.text).toBe(`Caption${captionEnd}Tail`);
      expect(stripped.segments).toEqual([
        { type: "media", url: "/tmp/real.png" },
        { type: "text", text: `Caption${captionEnd}Tail` },
      ]);
    },
  );

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

  it.each(["a* ", "] "])(
    "extracts images after oversized delimiter-heavy prose (%s)",
    (delimiter) => {
      const prose = delimiter.repeat(40_000);
      const url = "https://example.com/image.png";
      const startedAt = performance.now();
      expectParsedMediaOutputCase(
        `${prose}\n![image](${url})`,
        { text: prose.trimEnd(), mediaUrls: [url] },
        extractMarkdownImages,
      );
      // Quadratic delimiter scans take seconds; normal parsing stays well below this margin.
      expect(performance.now() - startedAt).toBeLessThan(2_000);
    },
  );
});
