export type WizardSelectOption<T = string> = {
  value: T;
  label: string;
  hint?: string;
};

export type WizardSelectParams<T = string> = {
  message: string;
  options: Array<WizardSelectOption<T>>;
  initialValue?: T;
  allowBack?: boolean;
};

export type WizardMultiSelectParams<T = string> = {
  message: string;
  options: Array<WizardSelectOption<T>>;
  initialValues?: T[];
  allowBack?: boolean;
};

export type WizardTextParams = {
  message: string;
  initialValue?: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
  allowBack?: boolean;
};

export type WizardConfirmParams = {
  message: string;
  initialValue?: boolean;
  allowBack?: boolean;
};

export type WizardProgress = {
  update: (message: string) => void;
  stop: (message: string) => void;
};

export const WIZARD_BACK = Symbol("WIZARD_BACK");

export type WizardPrompter = {
  intro: (title: string) => Promise<void>;
  outro: (message: string) => Promise<void>;
  note: (message: string, title?: string) => Promise<void>;
  select: <T>(params: WizardSelectParams<T>) => Promise<T | typeof WIZARD_BACK>;
  multiselect: <T>(params: WizardMultiSelectParams<T>) => Promise<T[] | typeof WIZARD_BACK>;
  text: (params: WizardTextParams) => Promise<string | typeof WIZARD_BACK>;
  confirm: (params: WizardConfirmParams) => Promise<boolean | typeof WIZARD_BACK>;
  progress: (label: string) => WizardProgress;
};

export class WizardCancelledError extends Error {
  constructor(message = "wizard cancelled") {
    super(message);
    this.name = "WizardCancelledError";
  }
}
