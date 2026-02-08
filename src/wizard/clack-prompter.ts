import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  type Option,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import type { WizardProgress, WizardPrompter } from "./prompts.js";
import { WIZARD_BACK, WizardCancelledError } from "./prompts.js";
import { createCliProgress } from "../cli/progress.js";
import { note as emitNote } from "../terminal/note.js";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";
import { theme } from "../terminal/theme.js";

function guardCancel<T>(value: T | symbol): T | typeof WIZARD_BACK {
  if (isCancel(value)) {
    cancel(stylePromptTitle("Setup cancelled.") ?? "Setup cancelled.");
    throw new WizardCancelledError();
  }
  if (value === WIZARD_BACK) {
    return WIZARD_BACK;
  }
  return value as T;
}

export function createClackPrompter(): WizardPrompter {
  return {
    intro: async (title) => {
      intro(stylePromptTitle(title) ?? title);
    },
    outro: async (message) => {
      outro(stylePromptTitle(message) ?? message);
    },
    note: async (message, title) => {
      emitNote(message, title);
    },
    select: async (params) => {
      const options = [...params.options];
      if (params.allowBack) {
        options.push({ value: WIZARD_BACK as any, label: "Go Back", hint: "Return to previous step" });
      }
      return guardCancel(
        await select({
          message: stylePromptMessage(params.message),
          options: options.map((opt) => {
            const base = { value: opt.value, label: opt.label };
            return opt.hint === undefined ? base : { ...base, hint: stylePromptHint(opt.hint) };
          }) as Option<(typeof options)[number]["value"]>[],
          initialValue: params.initialValue,
        }),
      );
    },
    multiselect: async (params) => {
      const options = [...params.options];
      // Note: Back in multiselect is tricky, usually not needed or handled via a special option
      return guardCancel(
        await multiselect({
          message: stylePromptMessage(params.message),
          options: options.map((opt) => {
            const base = { value: opt.value, label: opt.label };
            return opt.hint === undefined ? base : { ...base, hint: stylePromptHint(opt.hint) };
          }) as Option<(typeof options)[number]["value"]>[],
          initialValues: params.initialValues,
        }),
      );
    },
    text: async (params) => {
      const result = await text({
        message: stylePromptMessage(params.message + (params.allowBack ? " (type :back to go back)" : "")),
        initialValue: params.initialValue,
        placeholder: params.placeholder,
        validate: (val) => {
          if (params.allowBack && val.trim().toLowerCase() === ":back") return;
          return params.validate?.(val);
        },
      });
      if (!isCancel(result) && params.allowBack && result.trim().toLowerCase() === ":back") {
        return WIZARD_BACK;
      }
      return guardCancel(result);
    },
    confirm: async (params) => {
      // For confirm, we can't easily add a third option with @clack/prompts confirm
      // So we might use a select for confirm if back is needed, or just skip back for simple confirms
      return guardCancel(
        await confirm({
          message: stylePromptMessage(params.message),
          initialValue: params.initialValue,
        }),
      );
    },
    progress: (label: string): WizardProgress => {
      const spin = spinner();
      spin.start(theme.accent(label));
      const osc = createCliProgress({
        label,
        indeterminate: true,
        enabled: true,
        fallback: "none",
      });
      return {
        update: (message) => {
          spin.message(theme.accent(message));
          osc.setLabel(message);
        },
        stop: (message) => {
          osc.done();
          spin.stop(message);
        },
      };
    },
  };
}
