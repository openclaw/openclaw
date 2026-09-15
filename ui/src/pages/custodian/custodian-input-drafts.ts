import type { ApplicationContext } from "../../app/context.ts";
import {
  currentPluginHelpReference,
  subscribePluginHelp,
  takePluginHelpDraft,
} from "./plugin-help.ts";

/** Ordinary questions survive prompt replacement; hosted secrets use a separate draft. */
export class CustodianInputDrafts {
  ordinary = { value: "" };
  sensitive = { value: "" };
  private context: ApplicationContext | null = null;
  private cleanup: (() => void) | null = null;

  connect(context: ApplicationContext, notify: () => void): void {
    this.cleanup?.();
    this.context = context;
    this.cleanup = subscribePluginHelp(context, notify);
  }

  resetPrompt(
    host: { sensitive: boolean; wizardValue: unknown; wizardSecretVisible: boolean },
    sensitive: boolean,
  ): void {
    // Retire prompt input at admission or replacement, even if the reply fails.
    // Ordinary composer drafts survive explicit actions and prompt replacement.
    this.sensitive = { value: "" };
    [host.wizardValue, host.wizardSecretVisible] = [undefined, false];
    host.sensitive = sensitive;
  }

  get pluginReference() {
    return this.context ? currentPluginHelpReference(this.context) : undefined;
  }

  reconcile(
    ready: boolean,
    prompt: { sensitive: boolean; wizardInputPending: boolean; hasUnresolvedQuestion(): boolean },
  ): void {
    if (
      !this.context ||
      !ready ||
      prompt.sensitive ||
      prompt.wizardInputPending ||
      prompt.hasUnresolvedQuestion()
    ) {
      return;
    }
    const draft = takePluginHelpDraft(this.context);
    if (draft) {
      this.ordinary = { value: [this.ordinary.value, draft].filter(Boolean).join("\n\n") };
    }
  }
}
