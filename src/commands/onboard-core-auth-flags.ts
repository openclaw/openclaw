import type { AuthChoice, OnboardOptions } from "./onboard-types.js";

type OnboardCoreAuthOptionKey = keyof Pick<OnboardOptions, "litellmApiKey" | "puterApiKey">;

export type OnboardCoreAuthFlag = {
  optionKey: OnboardCoreAuthOptionKey;
  authChoice: AuthChoice;
  cliFlag: `--${string}`;
  cliOption: `--${string} <key>`;
  description: string;
};

export const CORE_ONBOARD_AUTH_FLAGS: ReadonlyArray<OnboardCoreAuthFlag> = [
  {
    optionKey: "puterApiKey",
    authChoice: "puter-api-key",
    cliFlag: "--puter-api-key",
    cliOption: "--puter-api-key <key>",
    description: "Puter API key",
  },
  {
    optionKey: "litellmApiKey",
    authChoice: "litellm-api-key",
    cliFlag: "--litellm-api-key",
    cliOption: "--litellm-api-key <key>",
    description: "LiteLLM API key",
  },
];
