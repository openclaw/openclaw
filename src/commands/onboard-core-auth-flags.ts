import type { AuthChoice, OnboardOptions } from "./onboard-types.js";

type OnboardCoreAuthOptionKey = keyof Pick<OnboardOptions, "commonstackApiKey" | "litellmApiKey">;

export type OnboardCoreAuthFlag = {
  optionKey: OnboardCoreAuthOptionKey;
  authChoice: AuthChoice;
  cliFlag: `--${string}`;
  cliOption: `--${string} <key>`;
  description: string;
};

export const CORE_ONBOARD_AUTH_FLAGS: ReadonlyArray<OnboardCoreAuthFlag> = [
  {
    optionKey: "commonstackApiKey",
    authChoice: "commonstack-api-key",
    cliFlag: "--commonstack-api-key",
    cliOption: "--commonstack-api-key <key>",
    description: "CommonStack API key",
  },
  {
    optionKey: "litellmApiKey",
    authChoice: "litellm-api-key",
    cliFlag: "--litellm-api-key",
    cliOption: "--litellm-api-key <key>",
    description: "LiteLLM API key",
  },
];
