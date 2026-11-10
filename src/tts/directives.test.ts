import { describe, expect, it } from "vitest";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { createSpeechDirectiveParser } from "./directive-parser.js";
import { parseTtsDirectives } from "./directives.js";
import type { SpeechModelOverridePolicy } from "./provider-types.js";
import { createSpeechPolicy, speechProvider } from "./speech-provider.test-support.js";

const speed: NonNullable<SpeechProviderPlugin["parseDirectiveToken"]> = ({ key, value }) =>
  key === "speed" ? { handled: true, overrides: { speed: Number(value) } } : { handled: false };
const elevenlabs = speechProvider("elevenlabs", {
  autoSelectOrder: 10,
  parseDirectiveToken: (ctx) =>
    ctx.key === "style" ? { handled: true, overrides: { style: Number(ctx.value) } } : speed(ctx),
});
const minimax = speechProvider("minimax", { autoSelectOrder: 20, parseDirectiveToken: speed });

const fullPolicy: SpeechModelOverridePolicy = createSpeechPolicy(true);

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

  it.each([
    [
      "minimax",
      "style=0.4 speed=1.2",
      { speed: 1.2 },
      ['unsupported minimax directive key "style"'],
    ],
    [
      "elevenlabs",
      "speakerVoice=Rachel speakerVoiceId=voice-123",
      {
        speakerVoice: "Rachel",
        voice: "Rachel",
        voiceName: "Rachel",
        speakerVoiceId: "voice-123",
        voiceId: "voice-123",
      },
      [],
    ],
  ] as const)("scopes directive tokens to %s", (provider, tokens, patch, warnings) => {
    const result = parse(`[[tts:provider=${provider} ${tokens}]]`);
    expect(result.overrides).toEqual({
      provider,
      providerOverrides: { [provider]: patch },
    });
    expect(result.warnings).toEqual(warnings);
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
