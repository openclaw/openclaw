import { describe, expect, it } from "vitest";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { createSpeechDirectiveParser } from "./directive-parser.js";
import { createTtsDirectiveTextStreamCleaner, parseTtsDirectives } from "./directives.js";
import type { SpeechModelOverridePolicy } from "./provider-types.js";

function makeProvider(
  id: string,
  order: number,
  parseToken: NonNullable<SpeechProviderPlugin["parseDirectiveToken"]>,
  options?: { aliases?: string[] },
): SpeechProviderPlugin {
  return {
    id,
    label: id,
    aliases: options?.aliases,
    autoSelectOrder: order,
    parseDirectiveToken: parseToken,
    isConfigured: () => true,
    synthesize: async () => ({
      audioBuffer: Buffer.alloc(0),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    }),
  } as SpeechProviderPlugin;
}

const speed: NonNullable<SpeechProviderPlugin["parseDirectiveToken"]> = ({ key, value }) =>
  key === "speed" ? { handled: true, overrides: { speed: Number(value) } } : undefined;
const elevenlabs = makeProvider("elevenlabs", 10, (ctx) =>
  ctx.key === "style" ? { handled: true, overrides: { style: Number(ctx.value) } } : speed(ctx),
);
const minimax = makeProvider("minimax", 20, speed);

const fullPolicy: SpeechModelOverridePolicy = {
  enabled: true,
  allowText: true,
  allowProvider: true,
  allowVoice: true,
  allowModelId: true,
  allowVoiceSettings: true,
  allowNormalization: true,
  allowSeed: true,
};

function parse(
  text: string,
  options: Parameters<typeof parseTtsDirectives>[2] = {},
  policy = fullPolicy,
) {
  return parseTtsDirectives(text, policy, { providers: [elevenlabs, minimax], ...options });
}

describe("parseTtsDirectives provider-aware routing", () => {
  it("accumulates provider patches without asking the provider to copy prior overrides", () => {
    const provider = makeProvider(
      "example",
      10,
      createSpeechDirectiveParser({
        voice: ["allowVoice", ["voice"]],
        speed: [
          "allowVoiceSettings",
          ["speed"],
          {
            number: { range: { min: 0.5, max: 2 }, warning: () => "invalid speed" },
          },
        ],
      }),
    );
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

  it("routes to preferred provider aliases when no provider token is declared", () => {
    const azure = makeProvider("azure-speech", 20, speed, { aliases: ["azure"] });

    const result = parse("[[tts:speed=1.5]]", {
      providers: [elevenlabs, azure],
      preferredProviderId: "azure",
    });

    expect(result.overrides.provider).toBeUndefined();
    expect(result.overrides.providerOverrides?.["azure-speech"]).toEqual({ speed: 1.5 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
  });

  it("falls back to autoSelectOrder when no provider hint is available", () => {
    const result = parse("[[tts:speed=1.5]]");

    expect(result.overrides.provider).toBeUndefined();
    expect(result.overrides.providerOverrides?.elevenlabs).toEqual({ speed: 1.5 });
    expect(result.overrides.providerOverrides?.minimax).toBeUndefined();
  });

  it("keeps explicit-provider tokens scoped to the selected provider", () => {
    const result = parse("[[tts:provider=minimax style=0.4 speed=1.2]]");

    expect(result.overrides.provider).toBe("minimax");
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.2 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
    expect(result.warnings).toContain('unsupported minimax directive key "style"');
  });

  it("routes generic speakerVoice directive tokens to the selected provider", () => {
    const result = parse(
      "[[tts:provider=elevenlabs speakerVoice=Rachel speakerVoiceId=voice-123]]",
    );

    expect(result.overrides.provider).toBe("elevenlabs");
    expect(result.overrides.providerOverrides?.elevenlabs).toEqual({
      speakerVoice: "Rachel",
      voice: "Rachel",
      voiceName: "Rachel",
      speakerVoiceId: "voice-123",
      voiceId: "voice-123",
    });
    expect(result.warnings).toStrictEqual([]);
  });

  it("warns once and drops non-provider tokens when the explicit provider is unknown", () => {
    const result = parse("[[tts:provider=missing speed=1.2 style=0.4]]");

    expect(result.overrides.provider).toBe("missing");
    expect(result.overrides.providerOverrides).toBeUndefined();
    expect(result.warnings).toEqual(['unknown provider "missing"']);
  });

  it("ignores provider tokens when provider overrides are disabled", () => {
    const policy: SpeechModelOverridePolicy = { ...fullPolicy, allowProvider: false };
    const result = parse(
      "[[tts:provider=elevenlabs speed=1.2]]",
      { preferredProviderId: "minimax" },
      policy,
    );

    expect(result.overrides.provider).toBeUndefined();
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.2 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
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

  it.each([
    {
      name: "a closed fence and inline span",
      input: `Use \`[[tts:text]]\` for hidden speech.\n\n\`\`\`\n${ttsExample}\n\`\`\`\n\nThen continue normally.`,
    },
  ])("does not parse tts examples inside $name", ({ input }) => {
    const result = parse(input);

    expect(result).toEqual({
      cleanedText: input,
      overrides: {},
      warnings: [],
      hasDirective: false,
    });
  });
});

describe("createTtsDirectiveTextStreamCleaner", () => {
  it("strips directive tags split across streamed chunks", () => {
    const cleaner = createTtsDirectiveTextStreamCleaner();

    expect(cleaner.push("Hello [[tts:voice=al")).toBe("Hello ");
    expect(cleaner.push("loy]]world[[/tt")).toBe("world");
    expect(cleaner.push("s]]")).toBe("");
    expect(cleaner.flush()).toBe("");
  });

  it("suppresses hidden tts text blocks while preserving normal text", () => {
    const cleaner = createTtsDirectiveTextStreamCleaner();

    expect(cleaner.push("Shown [[tts:text]]hid")).toBe("Shown ");
    expect(cleaner.push("den[[/tts:text]] visible")).toBe(" visible");
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
