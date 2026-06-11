// Wizard prompt types abstract selectable, confirm, and text prompts.
export type WizardSelectOption<T = string> = {
  value: T;
  label: string;
  hint?: string;
};

export type WizardSelectParams<T = string> = {
  message: string;
  options: Array<WizardSelectOption<T>>;
  initialValue?: T;
  searchable?: boolean;
};

export type WizardMultiSelectParams<T = string> = {
  message: string;
  options: Array<WizardSelectOption<T>>;
  initialValues?: T[];
  searchable?: boolean;
};

type WizardTextParams = {
  message: string;
  initialValue?: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
  // Render as a masked input. The entered value is never echoed to the
  // terminal — keeps secrets out of scrollback, transcripts, and screenshots.
  sensitive?: boolean;
};

type WizardConfirmParams = {
  message: string;
  initialValue?: boolean;
};

export type WizardProgress = {
  update: (message: string) => void;
  stop: (message?: string) => void;
};

export type WizardPrompter = {
  // True when the client renders auth challenges (OAuth URLs, device codes)
  // in-band itself — e.g. an RPC wizard client like the Windows companion that
  // receives wizard steps rather than the gateway's stdout/browser. Providers
  // use this to surface the authorization URL inside the prompt instead of
  // relying on a browser opened on the gateway host or terminal-only logging.
  presentsAuthChallenge?: boolean;
  intro: (title: string) => Promise<void>;
  outro: (message: string) => Promise<void>;
  note: (message: string, title?: string) => Promise<void>;
  plain?: (message: string) => Promise<void>;
  select: <T>(params: WizardSelectParams<T>) => Promise<T>;
  multiselect: <T>(params: WizardMultiSelectParams<T>) => Promise<T[]>;
  text: (params: WizardTextParams) => Promise<string>;
  confirm: (params: WizardConfirmParams) => Promise<boolean>;
  progress: (label: string) => WizardProgress;
};

export class WizardCancelledError extends Error {
  constructor(message = "wizard cancelled") {
    super(message);
    this.name = "WizardCancelledError";
  }
}
