import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type {
  SystemAgentSetupAuthStartParams,
  WizardNextResult,
  WizardStep,
} from "../../../packages/gateway-protocol/src/index.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import type { GatewayRequestFunction } from "../../gateway/call.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resolveManifestDeclaredProviderAuthChoices } from "../../plugins/provider-auth-choices.js";
import {
  formatProviderLoginChoiceRef,
  isProviderCliLoginChoiceStartable,
} from "../../plugins/provider-login-options.js";
import { ExitError, type RuntimeEnv } from "../../runtime.js";
import { sleep } from "../../utils/sleep.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { WizardCancelledError, type WizardPrompter } from "../../wizard/prompts.js";
import { readGatewayApiKeyParams } from "./auth-gateway.js";
import { normalizeManualAuthProvider } from "./auth-manual-input.js";

export async function readGatewayLoginParams(
  opts: { provider?: string; method?: string; agent?: string },
  sessionId: string,
  signal: AbortSignal,
): Promise<SystemAgentSetupAuthStartParams> {
  const provider = opts.provider ? normalizeManualAuthProvider(opts.provider) : undefined;
  const method = normalizeLowercaseStringOrEmpty(opts.method);
  const choices = resolveManifestDeclaredProviderAuthChoices({
    includeUntrustedWorkspacePlugins: false,
    includeWorkspacePlugins: false,
  }).filter(
    (choice) =>
      isProviderCliLoginChoiceStartable(choice) &&
      (provider === undefined || choice.providerId === provider) &&
      (!method || normalizeLowercaseStringOrEmpty(choice.methodId) === method),
  );
  if (!choices.length) {
    throw new Error(
      "No Gateway-compatible login matches this provider and method. Choose a declared credential-only sign-in method, or stop the Gateway through its service owner and rerun this command offline.",
    );
  }
  const prompter = createClackPrompter(process.stderr, signal);
  const choice = choices.length === 1 ? choices[0] : undefined;
  const authChoice = choice
    ? formatProviderLoginChoiceRef(choice)
    : await prompter
        .select({
          message: "Choose a provider sign-in method",
          options: choices.map((entry) => ({
            value: formatProviderLoginChoiceRef(entry),
            label: entry.choiceLabel,
            hint: `${entry.providerId} / ${entry.methodId}`,
          })),
        })
        .catch((error: unknown) => {
          if (error instanceof WizardCancelledError) throw new ExitError(0);
          throw error;
        });
  signal.throwIfAborted();
  return { sessionId, authChoice, agentId: opts.agent };
}

async function answerLoginStep(
  step: WizardStep,
  prompter: WizardPrompter,
  signal: AbortSignal,
): Promise<unknown> {
  const message = sanitizeTerminalText(step.message ?? step.title ?? "Continue");
  if (step.externalUrl)
    await prompter.note(sanitizeTerminalText(step.externalUrl), "Open this URL to continue");
  if (step.deviceCode)
    await prompter.note(sanitizeTerminalText(step.deviceCode.code), step.title ?? "Device code");
  switch (step.type) {
    case "text": {
      if (!process.stdin.isTTY && step.sensitive) {
        return (await readGatewayApiKeyParams({ provider: "login" }, signal)).apiKey;
      }
      const value = await prompter.text({
        message,
        sensitive: step.sensitive,
        placeholder: step.placeholder,
        initialValue: typeof step.initialValue === "string" ? step.initialValue : undefined,
        signal,
      });
      if (step.sensitive) registerSecretValueForRedaction(value);
      return value;
    }
    case "select":
      return prompter.select({
        message,
        options: step.options ?? [],
        initialValue: step.initialValue,
      });
    case "multiselect":
      return prompter.multiselect({
        message,
        options: step.options ?? [],
        initialValues: Array.isArray(step.initialValue) ? step.initialValue : undefined,
      });
    case "confirm":
    case "action":
      if (step.executor === "gateway") return undefined;
      return prompter.confirm({
        message,
        initialValue: typeof step.initialValue === "boolean" ? step.initialValue : undefined,
      });
    case "note":
      await prompter.note(message, step.title);
      return undefined;
    case "progress":
      await prompter.note(message, step.title);
      return undefined;
  }
}

async function answerBrowserStep(
  request: GatewayRequestFunction,
  sessionId: string,
  step: WizardStep,
  signal: AbortSignal,
): Promise<{ value: unknown } | { next: WizardNextResult }> {
  const prompt = new AbortController();
  const promptSignal = AbortSignal.any([signal, prompt.signal]);
  const answer = answerLoginStep(
    step,
    createClackPrompter(process.stderr, promptSignal),
    promptSignal,
  ).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    for (;;) {
      const tick = new AbortController();
      let answered: Awaited<typeof answer> | undefined;
      try {
        answered = await Promise.race([
          answer,
          sleep(1_000, AbortSignal.any([signal, tick.signal])).then(() => undefined),
        ]);
      } finally {
        tick.abort();
      }
      signal.throwIfAborted();
      if (answered) {
        if ("error" in answered) throw answered.error;
        return answered;
      }
      const next = await request<WizardNextResult>("wizard.next", { sessionId }, { signal });
      if (next.done || next.step?.id !== step.id) return { next };
    }
  } finally {
    prompt.abort();
    await answer;
  }
}

export async function runGatewayLoginWizard(
  request: GatewayRequestFunction,
  sessionId: string,
  signal: AbortSignal,
  runtime: RuntimeEnv,
): Promise<void> {
  const prompter = createClackPrompter(process.stderr, signal);
  let done = false;
  try {
    let result = await request<WizardNextResult>(
      "wizard.next",
      { sessionId },
      { signal, timeoutMs: 25 * 60_000 },
    );
    while (!result.done) {
      signal.throwIfAborted();
      if (result.error) runtime.error(sanitizeTerminalText(result.error));
      const step = result.step;
      let value: unknown;
      if (step?.type === "text" && step.externalUrl) {
        const answered = await answerBrowserStep(request, sessionId, step, signal);
        if ("next" in answered) {
          result = answered.next;
          continue;
        }
        value = answered.value;
      } else {
        value = step ? await answerLoginStep(step, prompter, signal) : undefined;
      }
      signal.throwIfAborted();
      try {
        result = await request<WizardNextResult>(
          "wizard.next",
          {
            sessionId,
            ...(step && step.type !== "progress" && step.executor !== "gateway"
              ? { answer: { stepId: step.id, value } }
              : {}),
          },
          { signal, timeoutMs: 25 * 60_000 },
        );
      } catch (error) {
        if (step?.type !== "text" || !step.externalUrl) throw error;
        // A browser callback can finish between the terminal answer and its RPC.
        // Reconcile that session's terminal result, without replaying the answer.
        const current = await request<WizardNextResult>("wizard.next", { sessionId }, { signal });
        if (!current.done) throw error;
        result = current;
      }
    }
    done = true;
    if (result.status === "cancelled") throw new WizardCancelledError(result.error);
    if (result.status === "error")
      throw new Error(result.error ?? "Gateway provider login failed.");
    runtime.log("Provider sign-in saved and connection update confirmed by the Gateway.");
  } catch (error) {
    if (!done && !signal.aborted) await request("wizard.cancel", { sessionId, closeInput: true });
    if (error instanceof WizardCancelledError) {
      runtime.log("Login session closed. Credentials already saved were not undone.");
      return;
    }
    throw error;
  }
}
