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
    id: id,
    label: id,
    autoSelectOrder: order,
    parseDirectiveToken: parse,
    isConfigured: () => true,
    synthesize: async () => ({ audio: Buffer.alloc(0), mimeType: "audio/mp3", voice: "" }),
  } as unknown as SpeechProviderPlugin;
}

// Two fake providers that both claim the generic `speed` token, matching the
// real ElevenLabs/MiniMax collision that surfaced the latent routing bug.
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
  it("routes generic `speed` to the explicitly declared provider (minimax)", () => {
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

  it("routes correctly even when provider= appears AFTER the generic token", () => {
    // Token order must not matter: pre-scan captures provider= before walk.
    const result = parseTtsDirectives("[[tts:speed=1.2 provider=minimax]] hi", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.overrides.provider).toBe("minimax");
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.2 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
  });

  it("routes to the explicit provider when it is elevenlabs", () => {
    const result = parseTtsDirectives("[[tts:provider=elevenlabs speed=0.9]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.overrides.provider).toBe("elevenlabs");
    expect(result.overrides.providerOverrides?.elevenlabs).toEqual({ speed: 0.9 });
    expect(result.overrides.providerOverrides?.minimax).toBeUndefined();
  });

  it("falls back to autoSelectOrder when no provider= is declared", () => {
    const result = parseTtsDirectives("[[tts:speed=1.5]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    // elevenlabs has the lower autoSelectOrder (10 vs 20) so it wins first-match.
    expect(result.overrides.provider).toBeUndefined();
    expect(result.overrides.providerOverrides?.elevenlabs).toEqual({ speed: 1.5 });
    expect(result.overrides.providerOverrides?.minimax).toBeUndefined();
  });

  it("falls through to other providers when the declared one does not handle the key", () => {
    // minimax does not handle `style`; routing should still succeed via elevenlabs.
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

  it("last-wins semantics for overrides.provider are preserved", () => {
    const result = parseTtsDirectives(
      "[[tts:provider=elevenlabs provider=minimax speed=1.1]]",
      fullPolicy,
      { providers: [elevenlabs, minimax] },
    );

    // overrides.provider reflects the last provider= token (legacy behavior).
    expect(result.overrides.provider).toBe("minimax");
    // Speed routes to the last-wins provider, not the first.
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.1 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
  });

  it("ignores provider= when policy.allowProvider is false and uses autoSelectOrder", () => {
    const policy: SpeechModelOverridePolicy = { ...fullPolicy, allowProvider: false };
    const result = parseTtsDirectives("[[tts:provider=minimax speed=1.2]]", policy, {
      providers: [elevenlabs, minimax],
    });

    // provider= is not honored → routing falls back to autoSelectOrder (elevenlabs first).
    expect(result.overrides.provider).toBeUndefined();
    expect(result.overrides.providerOverrides?.elevenlabs).toEqual({ speed: 1.2 });
    expect(result.overrides.providerOverrides?.minimax).toBeUndefined();
  });
});
