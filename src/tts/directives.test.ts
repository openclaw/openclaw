// TTS directive tests cover parsing and applying speech directives.
import { describe, expect, it } from "vitest";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { createTtsDirectiveTextStreamCleaner, parseTtsDirectives } from "./directives.js";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechModelOverridePolicy,
} from "./provider-types.js";

function makeProvider(
  id: string,
  order: number,
  parse: (ctx: SpeechDirectiveTokenParseContext) => SpeechDirectiveTokenParseResult | undefined,
  options?: { aliases?: string[] },
): SpeechProviderPlugin {
  return {
    id,
    label: id,
    aliases: options?.aliases,
    autoSelectOrder: order,
    parseDirectiveToken: parse,
    isConfigured: () => true,
    synthesize: async () => ({
      audioBuffer: Buffer.alloc(0),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    }),
  } as SpeechProviderPlugin;
}

const elevenlabs = makeProvider("elevenlabs", 10, ({ key, value }) => {
  if (key === "speed") {
    return { handled: true, overrides: { speed: Number(value) } };
  }
  if (key === "style") {
    return { handled: true, overrides: { style: Number(value) } };
  }
  return undefined;
});

const minimax = makeProvider("minimax", 20, ({ key, value }) => {
  if (key === "speed") {
    return { handled: true, overrides: { speed: Number(value) } };
  }
  return undefined;
});

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

describe("parseTtsDirectives provider-aware routing", () => {
  it("does not resolve providers when text has no directives", () => {
    const failProvider = {
      get id() {
        throw new Error("provider should not be read without directives");
      },
      get autoSelectOrder() {
        throw new Error("provider order should not be read without directives");
      },
    } as unknown as SpeechProviderPlugin;

    const result = parseTtsDirectives("hello without TTS markup", fullPolicy, {
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
    const azure = makeProvider(
      "azure-speech",
      20,
      ({ key, value }) => {
        if (key === "speed") {
          return { handled: true, overrides: { speed: Number(value) } };
        }
        return undefined;
      },
      { aliases: ["azure"] },
    );

    const result = parseTtsDirectives("[[tts:speed=1.5]]", fullPolicy, {
      providers: [elevenlabs, azure],
      preferredProviderId: "azure",
    });

    expect(result.overrides.provider).toBeUndefined();
    expect(result.overrides.providerOverrides?.["azure-speech"]).toEqual({ speed: 1.5 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
  });

  it("falls back to autoSelectOrder when no provider hint is available", () => {
    const result = parseTtsDirectives("[[tts:speed=1.5]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.overrides.provider).toBeUndefined();
    expect(result.overrides.providerOverrides?.elevenlabs).toEqual({ speed: 1.5 });
    expect(result.overrides.providerOverrides?.minimax).toBeUndefined();
  });

  it("keeps explicit-provider tokens scoped to the selected provider", () => {
    const result = parseTtsDirectives("[[tts:provider=minimax style=0.4 speed=1.2]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.overrides.provider).toBe("minimax");
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.2 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
    expect(result.warnings).toContain('unsupported minimax directive key "style"');
  });

  it("routes generic speakerVoice directive tokens to the selected provider", () => {
    const result = parseTtsDirectives(
      "[[tts:provider=elevenlabs speakerVoice=Rachel speakerVoiceId=voice-123]]",
      fullPolicy,
      { providers: [elevenlabs, minimax] },
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
    const result = parseTtsDirectives("[[tts:provider=missing speed=1.2 style=0.4]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.overrides.provider).toBe("missing");
    expect(result.overrides.providerOverrides).toBeUndefined();
    expect(result.warnings).toEqual(['unknown provider "missing"']);
  });

  it("ignores provider tokens when provider overrides are disabled", () => {
    const policy: SpeechModelOverridePolicy = { ...fullPolicy, allowProvider: false };
    const result = parseTtsDirectives("[[tts:provider=elevenlabs speed=1.2]]", policy, {
      providers: [elevenlabs, minimax],
      preferredProviderId: "minimax",
    });

    expect(result.overrides.provider).toBeUndefined();
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.2 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
  });

  it("accepts bare tts tags as a tagged-mode trigger", () => {
    const result = parseTtsDirectives("[[tts]] read this aloud", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.hasDirective).toBe(true);
    expect(result.cleanedText).toBe(" read this aloud");
    expect(result.ttsText).toBeUndefined();
  });

  it("accepts plain tts blocks as speak-and-show text", () => {
    const result = parseTtsDirectives("[[tts]]hello world[[/tts]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.hasDirective).toBe(true);
    expect(result.cleanedText).toBe("hello world");
    expect(result.ttsText).toBe("hello world");
  });

  it("strips orphan closing tts tags", () => {
    const result = parseTtsDirectives("spoken content[[/tts:text]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.hasDirective).toBe(true);
    expect(result.cleanedText).toBe("spoken content");
  });

  const ttsExample =
    "[[tts:text]]hidden example[[/tts:text]] [[tts]]visible example[[/tts]] " +
    "[[tts:provider=elevenlabs speed=1.2]] [[tts:Here is your answer]] [[tts]] [[/tts:text]]";

  it.each([
    {
      name: "a closed fence and inline span",
      input: [
        "Use `[[tts:text]]` for hidden speech.",
        "",
        "```",
        ttsExample,
        "```",
        "",
        "Then continue normally.",
      ].join("\n"),
    },
  ])("does not parse tts examples inside $name", ({ input }) => {
    const result = parseTtsDirectives(input, fullPolicy, {
      providers: [elevenlabs, minimax],
    });

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
