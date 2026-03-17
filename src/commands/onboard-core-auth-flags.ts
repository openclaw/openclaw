import type { AuthChoice, OnboardOptions } from "./onboard-types.js";

type OnboardCoreAuthOptionKey = keyof Pick<OnboardOptions, "aimlapiApiKey" | "litellmApiKey">;

export type OnboardCoreAuthFlag = {
  optionKey: OnboardCoreAuthOptionKey;
  authChoice: AuthChoice;
  cliFlag: `--${string}`;
  cliOption: `--${string} <key>`;
  description: string;
};

export const CORE_ONBOARD_AUTH_FLAGS: ReadonlyArray<OnboardCoreAuthFlag> = [
  {
    optionKey: "aimlapiApiKey",
    authChoice: "aimlapi-api-key",
    cliFlag: "--aimlapi-api-key",
    cliOption: "--aimlapi-api-key <key>",
    description: "AI/ML API key",
  },
  {
    optionKey: "litellmApiKey",
    authChoice: "litellm-api-key",
    cliFlag: "--litellm-api-key",
    cliOption: "--litellm-api-key <key>",
    description: "LiteLLM API key",
  },
];
