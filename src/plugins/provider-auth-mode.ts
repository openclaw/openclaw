import type { WizardPrompter } from "../wizard/prompts.js";
import type { SecretInputMode } from "./provider-auth-types.js";

export type SecretInputModePromptCopy = {
  modeMessage?: string;
  plaintextLabel?: string;
  plaintextHint?: string;
  refLabel?: string;
  refHint?: string;
};

/** Resolves whether setup stores a plaintext secret or an external secret reference. */
export async function resolveSecretInputModeForEnvSelection(params: {
  prompter: Pick<WizardPrompter, "select">;
  explicitMode?: SecretInputMode;
  copy?: SecretInputModePromptCopy;
}): Promise<SecretInputMode> {
  if (params.explicitMode) {
    return params.explicitMode;
  }
  if (typeof params.prompter.select !== "function") {
    // Non-interactive or minimal prompters cannot ask for a mode, so keep the
    // historical plaintext path unless the caller supplied an explicit mode.
    return "plaintext";
  }
  const selected = await params.prompter.select<SecretInputMode>({
    message: params.copy?.modeMessage ?? "How do you want to provide this API key?",
    initialValue: "plaintext",
    options: [
      {
        value: "plaintext",
        label: params.copy?.plaintextLabel ?? "Paste API key now",
        hint: params.copy?.plaintextHint ?? "Stores the key directly in OpenClaw config",
      },
      {
        value: "ref",
        label: params.copy?.refLabel ?? "Use external secret provider",
        hint:
          params.copy?.refHint ??
          "Stores a reference to env or configured external secret providers",
      },
    ],
  });
  // Treat unknown prompt return values as plaintext so custom prompt adapters
  // cannot accidentally switch users into an unsupported secret-ref flow.
  return selected === "ref" ? "ref" : "plaintext";
}
