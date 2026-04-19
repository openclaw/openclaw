import { describe, expect, it } from "vitest";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { parseTtsDirectives } from "./directives.js";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechModelOverridePolicy,
} from "./provider-types.js";

function makeProvider(
  id: string,
  order: number,
  parse: (ctx: SpeechDirectiveTokenParseContext) => SpeechDirectiveTokenParseResult | undefined,
): SpeechProviderPlugin {
  return {
    id,
    label: id,
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
  it("routes generic speed to the explicitly declared provider", () => {
    const result = parseTtsDirectives(
      "hello [[tts:provider=minimax speed=1.2]] world",
      fullPolicy,
      {
        providers: [elevenlabs, minimax],
      },
    );

    expect(result.overrides.provider).toBe("minimax");
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.2 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
  });

  it("routes correctly when provider appears after the generic token", () => {
    const result = parseTtsDirectives("[[tts:speed=1.2 provider=minimax]] hi", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.overrides.provider).toBe("minimax");
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.2 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
  });

  it("routes to the preferred provider when no provider token is declared", () => {
    const result = parseTtsDirectives("[[tts:speed=1.5]]", fullPolicy, {
      providers: [elevenlabs, minimax],
      preferredProviderId: "minimax",
    });

    expect(result.overrides.provider).toBeUndefined();
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.5 });
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

  it("falls through when the preferred provider does not handle the key", () => {
    const result = parseTtsDirectives("[[tts:provider=minimax style=0.4]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.overrides.provider).toBe("minimax");
    expect(result.overrides.providerOverrides?.elevenlabs).toEqual({ style: 0.4 });
    expect(result.overrides.providerOverrides?.minimax).toBeUndefined();
  });

  it("routes mixed tokens independently in the same directive", () => {
    const result = parseTtsDirectives("[[tts:provider=minimax style=0.4 speed=1.2]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.overrides.provider).toBe("minimax");
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.2 });
    expect(result.overrides.providerOverrides?.elevenlabs).toEqual({ style: 0.4 });
  });

  it("keeps last-wins provider semantics", () => {
    const result = parseTtsDirectives(
      "[[tts:provider=elevenlabs provider=minimax speed=1.1]]",
      fullPolicy,
      { providers: [elevenlabs, minimax] },
    );

    expect(result.overrides.provider).toBe("minimax");
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.1 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
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

  it("ignores directive-like tags inside inline code spans", () => {
    const input = '`messages.tts.auto = "tagged"` -> need `[[tts:text]]` tag';
    const result = parseTtsDirectives(input, fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.hasDirective).toBe(false);
    expect(result.cleanedText).toBe(input);
    expect(result.overrides).toEqual({});
  });

  it("ignores TTS directive blocks inside fenced code blocks", () => {
    const input = "Example:\n```md\n[[tts:text]]\nquoted example\n[[/tts:text]]\n```\nDone.";
    const result = parseTtsDirectives(input, fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.hasDirective).toBe(false);
    expect(result.cleanedText).toBe(input);
    expect(result.overrides).toEqual({});
  });

  it("keeps parsing real TTS text blocks when their body contains code", () => {
    const input = "[[tts:text]]Use `pnpm test` here.\n```sh\necho hello\n```\n[[/tts:text]]";
    const result = parseTtsDirectives(input, fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.hasDirective).toBe(true);
    expect(result.cleanedText).toBe("");
    expect(result.ttsText).toBe("Use `pnpm test` here.\n```sh\necho hello\n```");
  });

  it("still parses real directives outside code regions", () => {
    const input =
      "`[[tts:text]]` is literal here, but [[tts:provider=minimax speed=1.2]] should still apply.";
    const result = parseTtsDirectives(input, fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.hasDirective).toBe(true);
    expect(result.cleanedText).toContain("`[[tts:text]]`");
    expect(result.cleanedText).not.toContain("[[tts:provider=minimax speed=1.2]]");
    expect(result.overrides.provider).toBe("minimax");
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.2 });
  });

  it("still parses real text blocks that contain inline code", () => {
    const input = "[[tts:text]]Read `[[tts:text]]` literally.[[/tts:text]]";
    const result = parseTtsDirectives(input, fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.hasDirective).toBe(true);
    expect(result.cleanedText).toBe("");
    expect(result.ttsText).toBe("Read `[[tts:text]]` literally.");
    expect(result.overrides).toEqual({ ttsText: "Read `[[tts:text]]` literally." });
  });
});
