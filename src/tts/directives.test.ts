import { describe, expect, it } from "vitest";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { createSpeechDirectiveParser } from "./directive-parser.js";
import { createTtsDirectiveTextStreamCleaner, parseTtsDirectives } from "./directives.js";
import type { SpeechModelOverridePolicy } from "./provider-types.js";
import { createFullSpeechPolicy, speechProvider } from "./speech-provider.test-support.js";

const speed: NonNullable<SpeechProviderPlugin["parseDirectiveToken"]> = ({ key, value }) =>
  key === "speed" ? { handled: true, overrides: { speed: Number(value) } } : { handled: false };
const elevenlabs = speechProvider("elevenlabs", {
  autoSelectOrder: 10,
  parseDirectiveToken: (ctx) =>
    ctx.key === "style" ? { handled: true, overrides: { style: Number(ctx.value) } } : speed(ctx),
});
const minimax = speechProvider("minimax", { autoSelectOrder: 20, parseDirectiveToken: speed });

const fullPolicy: SpeechModelOverridePolicy = createFullSpeechPolicy();

function parse(
  text: string,
  options: Parameters<typeof parseTtsDirectives>[2] = {},
  policy = fullPolicy,
) {
  return parseTtsDirectives(text, policy, { providers: [elevenlabs, minimax], ...options });
}

describe("parseTtsDirectives provider-aware routing", () => {
  it("accumulates provider patches without asking the provider to copy prior overrides", () => {
    const provider = speechProvider("example", {
      autoSelectOrder: 10,
      parseDirectiveToken: createSpeechDirectiveParser({
        voice: ["allowVoice", ["voice"]],
        speed: [
          "allowVoiceSettings",
          ["speed"],
          {
            number: { range: { min: 0.5, max: 2 }, warning: () => "invalid speed" },
          },
        ],
      }),
    });
    const result = parse("[[tts:provider=example voice=speaker speed=1.25]]", {
      providers: [provider],
    });
    expect(result.overrides.providerOverrides?.example).toStrictEqual({
      voice: "speaker",
      speed: 1.25,
    });
    expect(result.warnings).toStrictEqual([]);
  });
  it("does not resolve providers when text has no directives", () => {
    const failProvider = {
      get id() {
        throw new Error("provider should not be read without directives");
      },
      get autoSelectOrder() {
        throw new Error("provider order should not be read without directives");
      },
    } as unknown as SpeechProviderPlugin;

    const result = parse("hello without TTS markup", {
      providers: [failProvider, failProvider],
    });

    expect(result).toEqual({
      cleanedText: "hello without TTS markup",
      overrides: {},
      warnings: [],
      hasDirective: false,
    });
  });

  it.each([
    ["auto order", {}, "elevenlabs"],
    [
      "preferred alias",
      {
        providers: [
          elevenlabs,
          speechProvider("azure-speech", {
            autoSelectOrder: 20,
            parseDirectiveToken: speed,
            aliases: ["azure"],
          }),
        ],
        preferredProviderId: "azure",
      },
      "azure-speech",
    ],
  ] as const)("routes implicit providers by %s", (_name, options, selected) => {
    expect(parse("[[tts:speed=1.5]]", options).overrides).toEqual({
      providerOverrides: { [selected]: { speed: 1.5 } },
    });
  });

  it("keeps explicit-provider tokens scoped to the selected provider", () => {
    const result = parse("[[tts:provider=minimax style=0.4 speed=1.2]]");

    expect(result.overrides).toEqual({
      provider: "minimax",
      providerOverrides: { minimax: { speed: 1.2 } },
    });
    expect(result.warnings).toContain('unsupported minimax directive key "style"');
  });

  it("routes generic speakerVoice directive tokens to the selected provider", () => {
    const result = parse(
      "[[tts:provider=elevenlabs speakerVoice=Rachel speakerVoiceId=voice-123]]",
    );

    expect(result.overrides).toEqual({
      provider: "elevenlabs",
      providerOverrides: {
        elevenlabs: {
          speakerVoice: "Rachel",
          voice: "Rachel",
          voiceName: "Rachel",
          speakerVoiceId: "voice-123",
          voiceId: "voice-123",
        },
      },
    });
    expect(result.warnings).toStrictEqual([]);
  });

  it("warns once and drops non-provider tokens when the explicit provider is unknown", () => {
    const result = parse("[[tts:provider=missing speed=1.2 style=0.4]]");

    expect(result.overrides).toEqual({ provider: "missing" });
    expect(result.warnings).toEqual(['unknown provider "missing"']);
  });

  it("ignores provider tokens when provider overrides are disabled", () => {
    const policy: SpeechModelOverridePolicy = { ...fullPolicy, allowProvider: false };
    const result = parse(
      "[[tts:provider=elevenlabs speed=1.2]]",
      { preferredProviderId: "minimax" },
      policy,
    );

    expect(result.overrides).toEqual({ providerOverrides: { minimax: { speed: 1.2 } } });
  });

  it.each([
    ["[[tts]] read this aloud", { cleanedText: " read this aloud", ttsText: undefined }],
    ["[[tts]]hello world[[/tts]]", { cleanedText: "hello world", ttsText: "hello world" }],
    ["spoken content[[/tts:text]]", { cleanedText: "spoken content" }],
  ] as const)("cleans visible tag forms: %s", (input, expected) => {
    expect(parse(input)).toMatchObject({ hasDirective: true, ...expected });
  });

  const ttsExample =
    "[[tts:text]]hidden example[[/tts:text]] [[tts]]visible example[[/tts]] " +
    "[[tts:provider=elevenlabs speed=1.2]] [[tts:Here is your answer]] [[tts]] [[/tts:text]]";

  it("does not parse tts examples inside a closed fence and inline span", () => {
    const input = `Use \`[[tts:text]]\` for hidden speech.\n\n\`\`\`\n${ttsExample}\n\`\`\`\n\nThen continue normally.`;
    expect(parse(input)).toEqual({
      cleanedText: input,
      overrides: {},
      warnings: [],
      hasDirective: false,
    });
  });
});

describe("createTtsDirectiveTextStreamCleaner", () => {
  it.each([
    [
      ["Hello [[tts:voice=al", "loy]]world[[/tt", "s]]"],
      ["Hello ", "world", ""],
    ],
    [
      ["Shown [[tts:text]]hid", "den[[/tts:text]] visible"],
      ["Shown ", " visible"],
    ],
  ] as const)("cleans every incremental chunk: %j", (chunks, expected) => {
    const cleaner = createTtsDirectiveTextStreamCleaner();
    expect(chunks.map((chunk) => cleaner.push(chunk))).toEqual(expected);
    expect(cleaner.flush()).toBe("");
  });

  it.each([
    [["Some [[tts:hello there]] note"], "Some hello there note"],
    [["Go [[tts:", "answered aloud]] back"], "Go answered aloud back"],
    [["Done. [[tts:first line\nsecond line]] more"], "Done. first line\nsecond line more"],
    [["Go [[tts:\nhello]] now"], "Go hello now"],
    [["[[tts]]read", " this[[/tts]] now"], "read this now"],
    [["See [[note"], "See [[note"],
    [
      ["[[tts:text]]Press the ` key.[[/tts:text]] Visible. [[tts:text]]Audio only.[[/tts:text]]"],
      " Visible. ",
    ],
    [
      [
        "[[tts:text]]Press the ` key.[[/tts:text]]",
        " Visible. [[tts:text]]Audio only.[[/tts:text]]",
      ],
      " Visible. ",
    ],
  ] as const)("preserves visible reply text across chunks: %j", (chunks, expected) => {
    const cleaner = createTtsDirectiveTextStreamCleaner();
    expect(chunks.map((chunk) => cleaner.push(chunk)).join("") + cleaner.flush()).toBe(expected);
  });

  it.each([
    ["```\n", "[[tts:literal", " speech]]\n", "```\n"],
    ["Use `", "[[tts:literal", " speech]]", "` here."],
    ["~~~\n~~~ [[note]]\n[[tts:Literal speech]]\n~~~"],
    ["~~~\n~~~ [[tts:voice=alloy]]\n[[tts:Literal speech]]\n~~~"],
  ])("preserves code literals across chunks: %j", (...chunks) => {
    const cleaner = createTtsDirectiveTextStreamCleaner();
    expect(chunks.map((chunk) => cleaner.push(chunk)).join("")).toBe(chunks.join(""));
    expect(cleaner.push("\n[[tts:Visible speech]]")).toBe("\nVisible speech");
    expect(cleaner.flush()).toBe("");
  });
});
