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
import { createCliProgress } from "../cli/progress.js";
import { note as emitNote } from "../terminal/note.js";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";
import { theme } from "../terminal/theme.js";
import { WizardCancelledError } from "./prompts.js";
import { searchableSelect } from "./searchable-select.js";

function guardCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel(stylePromptTitle("Setup cancelled.") ?? "Setup cancelled.");
    throw new WizardCancelledError();
  }
  return value;
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
    select: async (params) =>
      guardCancel(
        await select({
          message: stylePromptMessage(params.message),
          options: params.options.map((opt) => {
            const base = { value: opt.value, label: opt.label };
            return opt.hint === undefined ? base : { ...base, hint: stylePromptHint(opt.hint) };
          }) as Option<(typeof params.options)[number]["value"]>[],
          initialValue: params.initialValue,
        }),
      ),
    searchableSelect: async (params) => {
      try {
        return await searchableSelect({
          message: stylePromptMessage(params.message) ?? params.message,
          options: params.options.map((opt) => ({
            value: opt.value,
            label: opt.label,
            hint: opt.hint,
          })),
          initialValue: params.initialValue,
          maxVisible: params.maxVisible,
        });
      } catch (err) {
        // Only treat "cancelled" as user cancellation; rethrow other errors
        if (err instanceof Error && err.message === "cancelled") {
          cancel(stylePromptTitle("Setup cancelled.") ?? "Setup cancelled.");
          throw new WizardCancelledError();
        }
        throw err;
      }
    },
    multiselect: async (params) =>
      guardCancel(
        await multiselect({
          message: stylePromptMessage(params.message),
          options: params.options.map((opt) => {
            const base = { value: opt.value, label: opt.label };
            return opt.hint === undefined ? base : { ...base, hint: stylePromptHint(opt.hint) };
          }) as Option<(typeof params.options)[number]["value"]>[],
          initialValues: params.initialValues,
        }),
      ),
    text: async (params) => {
      const validate = params.validate;
      return guardCancel(
        await text({
          message: stylePromptMessage(params.message),
          initialValue: params.initialValue,
          placeholder: params.placeholder,
          validate: validate ? (value) => validate(value ?? "") : undefined,
        }),
      );
    },
    confirm: async (params) =>
      guardCancel(
        await confirm({
          message: stylePromptMessage(params.message),
          initialValue: params.initialValue,
        }),
      ),
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
