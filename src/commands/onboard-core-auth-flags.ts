import type { AuthChoice, OnboardOptions } from "./onboard-types.js";

type OnboardCoreAuthOptionKey = keyof Pick<
  OnboardOptions,
  | "litellmApiKey"
  | "azureOpenaiApiKey"
  | "azureOpenaiBaseUrl"
  | "azureOpenaiModelId"
  | "azureOpenaiApiVersion"
>;

export type OnboardCoreAuthFlag = {
  optionKey: OnboardCoreAuthOptionKey;
  authChoice: AuthChoice;
  cliFlag: `--${string}`;
  cliOption: `--${string} <value>`;
  description: string;
};

export const CORE_ONBOARD_AUTH_FLAGS: ReadonlyArray<OnboardCoreAuthFlag> = [
  {
    optionKey: "azureOpenaiApiKey",
    authChoice: "azure-openai-api-key",
    cliFlag: "--azure-openai-api-key",
    cliOption: "--azure-openai-api-key <value>",
    description: "Azure OpenAI API key",
  },
  {
    optionKey: "azureOpenaiBaseUrl",
    authChoice: "azure-openai-api-key",
    cliFlag: "--azure-openai-base-url",
    cliOption: "--azure-openai-base-url <value>",
    description: "Azure OpenAI base URL",
  },
  {
    optionKey: "azureOpenaiModelId",
    authChoice: "azure-openai-api-key",
    cliFlag: "--azure-openai-model-id",
    cliOption: "--azure-openai-model-id <value>",
    description: "Azure OpenAI deployment/model ID",
  },
  {
    optionKey: "azureOpenaiApiVersion",
    authChoice: "azure-openai-api-key",
    cliFlag: "--azure-openai-api-version",
    cliOption: "--azure-openai-api-version <value>",
    description: "Azure OpenAI API version",
  },
  {
    optionKey: "litellmApiKey",
    authChoice: "litellm-api-key",
    cliFlag: "--litellm-api-key",
    cliOption: "--litellm-api-key <value>",
    description: "LiteLLM API key",
  },
];
