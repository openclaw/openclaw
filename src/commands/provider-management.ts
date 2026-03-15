import type { WizardPrompter } from "../wizard/prompts.js";

export type ProviderManagementIntent = "switch-active" | "configure-provider";

export type ProviderManagementOption<T extends string = string> = {
  value: T;
  label: string;
  hint?: string;
};

type PromptProviderManagementIntentParams = {
  prompter: WizardPrompter;
  message: string;
  includeSkipOption: boolean;
  configuredCount: number;
  configureValue: string;
  switchValue: string;
  skipValue: string;
  configureLabel: string;
  configureHint?: string;
  switchLabel: string;
  switchHint?: string;
  skipLabel?: string;
  skipHint?: string;
};

export async function promptProviderManagementIntent(
  params: PromptProviderManagementIntentParams,
): Promise<string> {
  if (params.configuredCount <= 1) {
    return "switch-active";
  }
  return await params.prompter.select<string>({
    message: params.message,
    options: [
      {
        value: params.configureValue,
        label: params.configureLabel,
        hint: params.configureHint,
      },
      {
        value: params.switchValue,
        label: params.switchLabel,
        hint: params.switchHint,
      },
      ...(params.includeSkipOption
        ? [
            {
              value: params.skipValue,
              label: params.skipLabel ?? "Skip for now",
              hint: params.skipHint,
            },
          ]
        : []),
    ],
    initialValue: params.configureValue,
  });
}

export function buildProviderSelectionOptions<T extends string>(params: {
  intent: ProviderManagementIntent;
  options: Array<ProviderManagementOption<T>>;
  activeValue?: string;
  activeSuffix?: string;
  hiddenValues?: Iterable<string>;
}): Array<ProviderManagementOption<T>> {
  const hiddenValues = new Set(params.hiddenValues ?? []);
  return params.options
    .filter((option) => !hiddenValues.has(option.value))
    .map((option) =>
      option.value === params.activeValue
        ? {
            ...option,
            label: `${option.label}${params.activeSuffix ?? " [Active]"}`.trim(),
          }
        : option,
    );
}
