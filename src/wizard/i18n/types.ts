export type WizardLocale = "en" | "zh-CN" | "zh-TW" | "tr";

export type WizardI18nParams = Record<string, boolean | number | string | null | undefined>;

export type WizardTranslationTree = {
  readonly [key: string]: string | WizardTranslationTree;
};

export type WizardTranslationMap = WizardTranslationTree;
