export type ConfigUiPresentation = "phone-number";

/** Authored groups of immediate object properties; descendants stay with their parent. */
export type ConfigUiGroup = {
  id: string;
  title: string;
  order?: number;
  properties: string[];
};

/** UI metadata attached to config schema paths for forms, docs, and redaction policy. */
export type ConfigUiHint = {
  label?: string;
  help?: string;
  docsUrl?: string;
  tags?: string[];
  group?: string;
  groups?: ConfigUiGroup[];
  order?: number;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  presentation?: ConfigUiPresentation;
  itemTemplate?: unknown;
};

/** Config UI hints keyed by dotted config path, with `*` matching dynamic segments. */
export type ConfigUiHints = Record<string, ConfigUiHint>;
