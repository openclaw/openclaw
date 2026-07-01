import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectTtsApiKeyAssignments } from "./runtime-config-collectors-tts.js";
import { createResolverContext } from "./runtime-shared.js";

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

describe("collectTtsApiKeyAssignments", () => {
  it("collects SecretRefs from top-level TTS providers", () => {
    const tts: Record<string, unknown> = {
      providers: {
        elevenlabs: { apiKey: envRef("ELEVENLABS_API_KEY") },
      },
    };
    const context = createResolverContext({
      sourceConfig: {} as OpenClawConfig,
      env: {},
    });
    collectTtsApiKeyAssignments({
      tts,
      pathPrefix: "messages.tts",
      defaults: undefined,
      context,
    });
    expect(context.assignments.map((a) => a.path)).toEqual([
      "messages.tts.providers.elevenlabs.apiKey",
    ]);
  });

  it("collects SecretRefs from persona-level TTS provider overrides", () => {
    const tts: Record<string, unknown> = {
      personas: {
        narrator: {
          label: "Narrator",
          providers: {
            elevenlabs: { apiKey: envRef("NARRATOR_ELEVENLABS_KEY") },
          },
        },
      },
    };
    const context = createResolverContext({
      sourceConfig: {} as OpenClawConfig,
      env: {},
    });
    collectTtsApiKeyAssignments({
      tts,
      pathPrefix: "messages.tts",
      defaults: undefined,
      context,
    });
    expect(context.assignments.map((a) => a.path)).toEqual([
      "messages.tts.personas.narrator.providers.elevenlabs.apiKey",
    ]);
  });

  it("collects SecretRefs from both top-level and persona-level providers", () => {
    const tts: Record<string, unknown> = {
      providers: {
        openai: { apiKey: envRef("TTS_OPENAI_KEY") },
      },
      personas: {
        narrator: {
          providers: {
            elevenlabs: { apiKey: envRef("NARRATOR_ELEVENLABS_KEY") },
          },
        },
        assistant: {
          providers: {
            openai: { apiKey: envRef("ASSISTANT_OPENAI_KEY") },
          },
        },
      },
    };
    const context = createResolverContext({
      sourceConfig: {} as OpenClawConfig,
      env: {},
    });
    collectTtsApiKeyAssignments({
      tts,
      pathPrefix: "messages.tts",
      defaults: undefined,
      context,
    });
    expect(context.assignments.map((a) => a.path)).toEqual([
      "messages.tts.providers.openai.apiKey",
      "messages.tts.personas.narrator.providers.elevenlabs.apiKey",
      "messages.tts.personas.assistant.providers.openai.apiKey",
    ]);
  });

  it("skips personas without providers", () => {
    const tts: Record<string, unknown> = {
      personas: {
        narrator: {
          label: "Narrator",
          provider: "elevenlabs",
        },
      },
    };
    const context = createResolverContext({
      sourceConfig: {} as OpenClawConfig,
      env: {},
    });
    collectTtsApiKeyAssignments({
      tts,
      pathPrefix: "messages.tts",
      defaults: undefined,
      context,
    });
    expect(context.assignments).toEqual([]);
  });

  it("collects persona refs with agent-level path prefix", () => {
    const tts: Record<string, unknown> = {
      personas: {
        narrator: {
          providers: {
            elevenlabs: { apiKey: envRef("AGENT_NARRATOR_KEY") },
          },
        },
      },
    };
    const context = createResolverContext({
      sourceConfig: {} as OpenClawConfig,
      env: {},
    });
    collectTtsApiKeyAssignments({
      tts,
      pathPrefix: "agents.list.0.tts",
      defaults: undefined,
      context,
    });
    expect(context.assignments.map((a) => a.path)).toEqual([
      "agents.list.0.tts.personas.narrator.providers.elevenlabs.apiKey",
    ]);
  });
});
