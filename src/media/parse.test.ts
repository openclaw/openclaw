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
  }

  function expectStableAudioAsVoiceDetectionCase(input: string) {
    for (const output of [splitMediaFromOutput(input), splitMediaFromOutput(input)]) {
      expect(output.audioAsVoice).toBe(true);
    }
  }

  function expectAcceptedMediaPathCase(expectedPath: string, input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: [expectedPath] });
    expect(splitMediaFromOutput(input).segments).toEqual([{ type: "media", url: expectedPath }]);
  }

  function expectRejectedMediaPathCase(input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: undefined });
  }

  function expectUnrecognizedMediaTextCase(input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: undefined, text: input });
  }

  function expectPolicyRejectedMediaUrlCase(input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: undefined, text: "" });
    expect(splitMediaFromOutput(input).rejectedMediaCount).toBe(1);
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
    expectParsedMediaOutputCase(input, { mediaUrls: [...mediaUrls] });
    expect(splitMediaFromOutput(input).segments).toEqual(
      mediaUrls.map((url) => ({ type: "media", url })),
    );
  });

  it.each([
    // The directive pattern consumes one backtick pair around the payload before the references are read,
    // exactly as it does on `origin/main`, so the whitespace inside still separates them. Letting the
    // capture keep the backticks made the payload one quoted value and delivered the single filename
    // `/tmp/a.png /tmp/b.png`, which exists nowhere.
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
    // A reply that pastes a serialized array onto the directive states its references with the same quote
    // pairs as the quoted comma list above, so each member is a reference of its own. Only the compact
    // spelling was read: the leading `[` made the list scan report "no list", and `cleanCandidate`'s
    // serialized-JSON salvage then cut the payload at the last extension before a comma-delimited quote, so
    // `MEDIA:["/tmp/a.png","/tmp/b.png"]` attached one file and dropped the rest with no failure recorded,
    // while the same array written with a space after each comma attached both.
    expectParsedMediaOutputCase(input, { mediaUrls: [...mediaUrls] });
  });

  it("separates every quoted member of a list, bare filenames included", () => {
    // A bare filename is a reference on its own — `MEDIA:"second.png"` attaches it — so quoting two of them
    // states two references, not one. Validating a member as if it were unquoted dropped it, and the
    // fallback then welded the leftover onto its neighbour: `MEDIA:"second.png" "/tmp/first.png"` attached
    // `/tmp/first.png` and leaked `"second.png"` into the visible reply text, while
    // `MEDIA:"/tmp/first.png" "second.png"` attached `/tmp/first.png" "second.png`, which exists nowhere. A
    // list's quote pairs already state where each reference ends, so no member is rebuilt into another.
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
    // A comma already reads as list punctuation on an unquoted line: `cleanCandidate` trims it from a
    // reference's tail, so `MEDIA:/tmp/first.png, /tmp/second.png` gives two attachments. Quoting each
    // reference moves that comma outside the quote pair, where the list scan gave it no meaning, so the
    // pair fell back to the whole-payload reading and attached one
    // `/tmp/first image.png", "/tmp/second image.png` — the two attachments that the space-separated list
    // of the same references produces.
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
    // A member that is not a reference of its own stays visible text rather than joining its neighbour,
    // which is what the space-separated list already does.
    expectParsedMediaOutputCase('MEDIA:"/tmp/first.png", "second"', {
      mediaUrls: ["/tmp/first.png"],
      text: '"second"',
    });
    // A comma inside one quoted reference stays part of its value, not a separator.
    expectAcceptedMediaPathCase("/tmp/Hello, World.png", 'MEDIA:"/tmp/Hello, World.png"');
    // Prose behind the comma is a token no quote pair bounds, so no list forms and `main`'s reading of the
    // payload stands.
    expectParsedMediaOutputCase('MEDIA:"/tmp/first.png", the picture above', {
      mediaUrls: ["/tmp/first.png"],
    });
    // A comma divides references only when the next reference is quoted behind it. Here the character
    // before the comma is an apostrophe belonging to the directory name (`Students', 2024`), and `main`
    // delivers both of these references, so the first one has to run to its real closing quote rather than
    // end at that apostrophe and leave an unquoted fragment that welds the pair into one path.
    expectParsedMediaOutputCase("MEDIA:'/tmp/Students', 2024/album.png' '/tmp/second.png'", {
      mediaUrls: ["/tmp/Students', 2024/album.png", "/tmp/second.png"],
    });
    // With a quoted reference behind it the same comma is list punctuation, as this form's unquoted and
    // space-separated siblings already read it.
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
    // A list states its references through its quote pairs, so a list that yields no reference yields
    // none at all — there is no whole-payload reading left to take. Cleaning the payload anyway welded
    // the rejects into a file neither member names and dropped the text with it:
    // `MEDIA:"first.png," "second.png,"` attached `first.png," "second.png`, while the recorded base
    // rejects the payload and keeps the line as visible text. The weld needed an extension on the last
    // member, which is what these three shapes carry.
    expectUnrecognizedMediaTextCase(input);
  });

  it("keeps a quoted list whose every member is rejected as text", () => {
    // The lookalikes around the weld: rejected members that leave the payload unable to pass as a
    // filename at all, so these stayed text even while the weld was reachable.
    for (const input of [
      'MEDIA:"first.png," "second"',
      'MEDIA:"first" "second"',
      "MEDIA:'first.png,' 'second'",
    ] as const) {
      expectUnrecognizedMediaTextCase(input);
    }
    // An accepted member beside a rejected one is untouched: it is the only member that ever reaches
    // the accepted path, and the reject stays text.
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
    // A quoted reference is one whitespace-delimited token, so a quote inside its value never ends the
    // token. Tokenizing on the quote itself cuts the signed URL short and leaks the rest into the
    // visible reply text, which is the same shortening this branch set out to remove — here for a
    // payload that also lists a second reference.
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
      // The list check and the tokenizer must agree on where a reference ends, so a quoted second
      // reference separates from the first one even when the first value holds that same inner quote.
      [
        "MEDIA:'https://example.com/video.mp4?token=it's' '/tmp/second.png'",
        ["https://example.com/video.mp4?token=it's", "/tmp/second.png"],
      ],
      [
        'MEDIA:"https://example.com/video.mp4?token=it\'s" "/tmp/second.png"',
        ["https://example.com/video.mp4?token=it's", "/tmp/second.png"],
      ],
    ] as const) {
      expectParsedMediaOutputCase(input, { mediaUrls: [...expected] });
      expect(splitMediaFromOutput(input).segments).toEqual(
        expected.map((url) => ({ type: "media", url })),
      );
    }
  });

  it("keeps a quoted reference whole when its own value holds that quote and whitespace", () => {
    // A quoted value can hold an inner quote and real filename whitespace at the same time. The closing
    // quote is the first one followed by whitespace or the end of the line, so `'/tmp/team's.v1
    // final/image.png'` is one reference; reading the inner quote as a delimiter split one path into two
    // attachments, which `main` does not do.
    for (const [input, expected] of [
      ["MEDIA:'/tmp/team's.v1 final/image.png'", ["/tmp/team's.v1 final/image.png"]],
      [
        "MEDIA:'/tmp/team's.v1 final/image.png' '/tmp/second.png'",
        ["/tmp/team's.v1 final/image.png", "/tmp/second.png"],
      ],
    ] as const) {
      expectParsedMediaOutputCase(input, { mediaUrls: [...expected] });
      expect(splitMediaFromOutput(input).segments).toEqual(
        expected.map((url) => ({ type: "media", url })),
      );
    }
  });

  it.each([
    // An inner quote can be followed by whitespace rather than a character. The quote pair still
    // encloses one value, so `main` reads one reference: `'/tmp/parents' photos/photo.png'` is a single
    // path whose name holds an apostrophe, not a quoted reference plus a stray tail. Counting the two
    // tokens the tokenizer returns for it as a quoted list disabled unwrapping while the quoted-token
    // guard blocked reconstruction, so one attachment became two.
    ["MEDIA:'/tmp/parents' photos/photo.png'", ["/tmp/parents' photos/photo.png"]],
    ['MEDIA:"/tmp/parents" photos/photo.png"', ['/tmp/parents" photos/photo.png']],
    // The same value beside a quoted sibling. The tail does not close a chunk, so the payload is not a
    // list of quoted references; `main` fuses the ambiguous remainder into the first value and this
    // branch keeps that reading rather than inventing a second reference out of the tail.
    [
      "MEDIA:'/tmp/parents' photos/photo.png' '/tmp/second.png'",
      ["/tmp/parents' photos/photo.png' '/tmp/second.png"],
    ],
  ] as const)(
    "keeps an inner quote followed by whitespace inside one quoted reference: %s",
    (input, mediaUrls) => {
      expectParsedMediaOutputCase(input, { mediaUrls: [...mediaUrls] });
      expect(splitMediaFromOutput(input).segments).toEqual(
        mediaUrls.map((url) => ({ type: "media", url })),
      );
    },
  );

  it.each([
    // A quote pair inside one unquoted path is text in the filename, not a reference: `'/tmp/album
    // 'best' photos/image.png'` is a single path step to `main`. Treating that pair as a boundary split
    // the path in two and leaked the fragment into the visible reply text, which loses an attachment
    // that used to prepare. Only a payload that quotes every one of its references is a list.
    ["MEDIA:/tmp/album 'best' photos/image.png", ["/tmp/album 'best' photos/image.png"]],
    ['MEDIA:/tmp/album "best" photos/image.png', ['/tmp/album "best" photos/image.png']],
    [
      "MEDIA:/tmp/album 'best' photos/image.png /tmp/second.png",
      ["/tmp/album 'best' photos/image.png", "/tmp/second.png"],
    ],
    // The same fragment split one path again as soon as it validated as media on its own, which a slash
    // inside it is enough to do (`'best/photos'`). Whether a fragment would be accepted says nothing
    // about whether the payload lists references, so it must not steer the join either.
    ["MEDIA:/tmp/album 'best/photos' final.png", ["/tmp/album 'best/photos' final.png"]],
    ['MEDIA:/tmp/album "best/photos" final.png', ['/tmp/album "best/photos" final.png']],
    [
      "MEDIA:/tmp/album 'best/photos' final.png /tmp/second.png",
      ["/tmp/album 'best/photos' final.png", "/tmp/second.png"],
    ],
    // The fragment can also end on the slash, which makes the quote pair run into the sibling instead of
    // closing on whitespace. The sibling is still an explicitly quoted reference of its own, so it must
    // stay separate rather than being swallowed into the path before it.
    [
      "MEDIA:/tmp/album 'best'/final.png '/tmp/second.png'",
      ["/tmp/album 'best'/final.png", "/tmp/second.png"],
    ],
    [
      "MEDIA:/tmp/album 'best' photos/image.png '/tmp/second.png'",
      ["/tmp/album 'best' photos/image.png", "/tmp/second.png"],
    ],
  ] as const)("keeps a quoted fragment inside one unquoted reference: %s", (input, mediaUrls) => {
    expectParsedMediaOutputCase(input, { mediaUrls: [...mediaUrls] });
    expect(splitMediaFromOutput(input).segments).toEqual(
      mediaUrls.map((url) => ({ type: "media", url })),
    );
  });

  it("keeps a quoted relative reference separate from the quoted reference before it", () => {
    // Explicit quotes already delimit each reference. The unquoted-path reconstruction heuristic exists
    // for bare paths with real filename spaces, so it must not reach across those quotes and fuse the
    // second reference into the first one.
    for (const [input, expected] of [
      [
        'MEDIA:"/tmp/first image.png" "media/second image.png"',
        ["/tmp/first image.png", "media/second image.png"],
      ],
    ] as const) {
      expectParsedMediaOutputCase(input, { mediaUrls: [...expected] });
      expect(splitMediaFromOutput(input).segments).toEqual(
        expected.map((url) => ({ type: "media", url })),
      );
    }
  });

  it("keeps a trailing quote pair inside one quoted reference", () => {
    // The two closing quotes pair up with nothing between them, so they are part of the single quoted
    // value rather than a second, empty reference. Splitting there would cut the signed URL short and
    // leak the quotes into the visible reply text.
    expectParsedMediaOutputCase('MEDIA:"https://example.com/video.mp4?token=ends"""', {
      mediaUrls: ['https://example.com/video.mp4?token=ends""'],
    });
  });

  it.each([
    // A quote that never closes cannot delimit a reference, so the payload is not a list and reads exactly
    // as origin/main reads it: the stray quote is either cleaned off the reference or kept as literal text.
    ["MEDIA:'/tmp/photo.png", ["/tmp/photo.png"]],
    ['MEDIA:"/tmp/photo.png', ["/tmp/photo.png"]],
    ["MEDIA:`/tmp/photo.png", ["/tmp/photo.png"]],
    ["MEDIA:/tmp/photo.png'", ["/tmp/photo.png"]],
    // An unclosed quote must not fuse two references that whitespace already separated.
    ["MEDIA:/tmp/photo.png '/tmp/second.png", ["/tmp/photo.png", "/tmp/second.png"]],
    // An unclosed quote is not a boundary either, so this stays the one reference `main` reads.
    ["MEDIA:'/tmp/first.png' \"/tmp/second.png'", ["/tmp/first.png' \"/tmp/second.png"]],
    // A single quoted value is one reference even when the quote pair wraps leading whitespace.
    ["MEDIA:' /tmp/photo.png'", ["/tmp/photo.png"]],
    // The slash-bearing quote pair from the previous round keeps its reading with a stray quote added.
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
    // Quoted punctuation belongs to the reference, exactly as it does when the directive holds a
    // single reference. A signed URL loses its signature when that suffix is stripped during
    // splitting, and the delivery then fails even though the reference looked accepted.
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

  it("selects an explicitly allowlisted file URL", () => {
    const url = "file:///tmp/selected.png";
    expectParsedMediaOutputCase(
      `Before ![selected](${url}) after`,
      { text: "Before after", mediaUrls: [url] },
      { markdownImageAllowlist: [url] },
    );
  });

  it("preserves blockquote inline semantics when locating an image", () => {
    const url = "https://example.com/chart.png";
    expectParsedMediaOutputCase(
      `> <span title="![chart](${url})"\n> caption`,
      { text: '> <span title=""\n> caption', mediaUrls: [url] },
      extractMarkdownImages,
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

  it("locates quoted images after an identical code example", () => {
    const image = "![chart](https://example.com/chart.png)";
    expectParsedMediaOutputCase(
      `> \`${image}\` ${image}`,
      { text: `> \`${image}\``, mediaUrls: ["https://example.com/chart.png"] },
      extractMarkdownImages,
    );
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

  it("preserves balanced punctuation at the end of a Markdown image destination", () => {
    const url = "https://example.com/render?label=(chart)";
    expectParsedMediaOutputCase(
      `![chart](${url})`,
      { text: "", mediaUrls: [url] },
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
