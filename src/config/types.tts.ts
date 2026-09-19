// Defines text-to-speech configuration types from the canonical authoring schema.
import type { z } from "zod";
import type { TtsConfigSchema } from "./zod-schema.core.js";

type TtsConfigInput = NonNullable<z.input<typeof TtsConfigSchema>>;
type TtsProviderConfigInput = NonNullable<TtsConfigInput["providers"]>[string];

export type TtsProvider = NonNullable<TtsConfigInput["provider"]>;
export type TtsMode = NonNullable<TtsConfigInput["mode"]>;
export type TtsAutoMode = NonNullable<TtsConfigInput["auto"]>;
export type TtsModelOverrideConfig = NonNullable<TtsConfigInput["modelOverrides"]>;
type TtsProviderConfig = Record<string, unknown> & Pick<TtsProviderConfigInput, "apiKey">;
export type TtsProviderConfigMap = Record<string, TtsProviderConfig>;
type TtsPersonaConfigInput = NonNullable<TtsConfigInput["personas"]>[string];
export type TtsPersonaConfig = Omit<TtsPersonaConfigInput, "providers"> & {
  providers?: TtsProviderConfigMap;
};
export type TtsPersonaFallbackPolicy = NonNullable<TtsPersonaConfig["fallbackPolicy"]>;

export type ResolvedTtsPersona = TtsPersonaConfig & {
  id: string;
};

export type TtsConfig = Omit<TtsConfigInput, "personas" | "providers"> & {
  personas?: Record<string, TtsPersonaConfig>;
  providers?: TtsProviderConfigMap;
};
