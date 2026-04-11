import type { GuardrailProvider } from "./types.js";

let guardrailProvider: GuardrailProvider | undefined;
let guardrailFailClosed = true;

export function configureGuardrails(
  provider: GuardrailProvider | undefined,
  failClosed = true,
): void {
  guardrailProvider = provider;
  guardrailFailClosed = failClosed;
}

export function getConfiguredGuardrails(): {
  provider: GuardrailProvider | undefined;
  failClosed: boolean;
} {
  return {
    provider: guardrailProvider,
    failClosed: guardrailFailClosed,
  };
}
