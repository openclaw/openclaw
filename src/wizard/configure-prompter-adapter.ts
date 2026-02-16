import { spinner as clackSpinner } from "@clack/prompts";
/**
 * Adapter: creates a WizardPrompter from the @clack/prompts primitives.
 * Used by configure-memory.ts to reuse attemptAutoSetup()
 * without duplicating the auto-setup logic.
 */
import type { WizardPrompter, WizardProgress } from "./prompts.js";
import { note as terminalNote } from "../terminal/note.js";

export function createConfigurePrompterAdapter(): WizardPrompter {
  return {
    intro: async () => {},
    outro: async () => {},
    note: async (message: string, title?: string) => {
      terminalNote(message, title);
    },
    select: async <T>(params: {
      message: string;
      options: Array<{ value: T }>;
      initialValue?: T;
    }) => {
      // Auto-setup does not use select — return initialValue or first option
      return params.initialValue ?? params.options[0].value;
    },
    multiselect: async () => [],
    text: async (params: { message: string; initialValue?: string }) => {
      return params.initialValue ?? "";
    },
    confirm: async (params: { message: string; initialValue?: boolean }) => {
      return params.initialValue ?? true;
    },
    progress: (label: string): WizardProgress => {
      const s = clackSpinner();
      s.start(label);
      return {
        update: (message: string) => {
          s.message(message);
        },
        stop: (message?: string) => {
          s.stop(message ?? label);
        },
      };
    },
  };
}
