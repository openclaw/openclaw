/** Tests for TTS SecretRef assignment metadata and startup optionality. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectTtsApiKeyAssignments } from "./runtime-config-collectors-tts.js";
import { createResolverContext } from "./runtime-shared.js";

const ELEVENLABS_API_KEY_REF = {
  source: "env",
  provider: "default",
  id: "ELEVENLABS_API_KEY",
} as const;

function createContext() {
  return createResolverContext({
    sourceConfig: {} as OpenClawConfig,
    env: {},
  });
}

describe("collectTtsApiKeyAssignments", () => {
  it("marks active TTS provider SecretRefs as optional startup assignments", () => {
    const tts = {
      providers: {
        elevenlabs: {
          apiKey: ELEVENLABS_API_KEY_REF,
        },
      },
    };
    const context = createContext();

    collectTtsApiKeyAssignments({
      tts,
      pathPrefix: "messages.tts",
      defaults: undefined,
      context,
    });

    expect(context.assignments).toHaveLength(1);
    expect(context.assignments[0]).toMatchObject({
      path: "messages.tts.providers.elevenlabs.apiKey",
      expected: "string",
      optional: true,
      unavailableValue: undefined,
    });
    expect(context.assignments[0]?.optionalReason).toContain("only speech synthesis");

    context.assignments[0]?.apply("test-api-key");
    expect(tts.providers.elevenlabs.apiKey).toBe("test-api-key");
  });

  it("keeps inactive TTS provider SecretRefs out of resolution", () => {
    const tts = {
      providers: {
        elevenlabs: {
          apiKey: ELEVENLABS_API_KEY_REF,
        },
      },
    };
    const context = createContext();

    collectTtsApiKeyAssignments({
      tts,
      pathPrefix: "agents.list.0.tts",
      defaults: undefined,
      context,
      active: false,
      inactiveReason: "agent is disabled.",
    });

    expect(context.assignments).toEqual([]);
    expect(context.warnings).toMatchObject([
      {
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "agents.list.0.tts.providers.elevenlabs.apiKey",
      },
    ]);
    expect(tts.providers.elevenlabs.apiKey).toEqual(ELEVENLABS_API_KEY_REF);
  });
});
