import {
  collectSecretInputAssignment,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

export function collectTtsApiKeyAssignments(params: {
  tts: Record<string, unknown>;
  pathPrefix: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
}): void {
  const elevenlabs = params.tts.elevenlabs;
  if (isRecord(elevenlabs)) {
    collectSecretInputAssignment({
      value: elevenlabs.apiKey,
      path: `${params.pathPrefix}.elevenlabs.apiKey`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: params.active,
      inactiveReason: params.inactiveReason,
      apply: (value) => {
        elevenlabs.apiKey = value;
      },
    });
  }
  const openai = params.tts.openai;
  if (isRecord(openai)) {
    collectSecretInputAssignment({
      value: openai.apiKey,
      path: `${params.pathPrefix}.openai.apiKey`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: params.active,
      inactiveReason: params.inactiveReason,
      apply: (value) => {
        openai.apiKey = value;
      },
    });
  }
}
