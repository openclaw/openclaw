// Doctor preview warnings when code mode is enabled alongside local model providers.
import { isRecord as hasRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { CodeModeConfig } from "../../../config/types.tools.js";
import { resolveDoctorPrimaryModelRef } from "./primary-model-ref.js";

const LOCAL_CODE_MODE_PROVIDERS = new Set(["lmstudio", "ollama"]);

const CODE_MODE_LOCAL_WARNING =
  "Code mode is enabled with a local model provider (lmstudio/ollama) available. Some local models pass shell strings into code-mode exec (`ls`, `/bin/…`) and retry through guest SyntaxError/ReferenceError storms. Prefer a known-good cloud model on the openclaw harness for code-mode sessions, or verify the model with a locked catalog prompt. See https://docs.openclaw.ai/tools/code-mode";

function isCodeModeEnabled(value: CodeModeConfig | undefined): boolean {
  if (value === true) {
    return true;
  }
  return hasRecord(value) && value.enabled === true;
}

function providerFromModelRef(ref: string): string {
  const slash = ref.indexOf("/");
  return (slash === -1 ? ref : ref.slice(0, slash)).trim().toLowerCase();
}

function configTouchesLocalCodeModeProviders(cfg: OpenClawConfig): boolean {
  const primary = resolveDoctorPrimaryModelRef(cfg);
  if (LOCAL_CODE_MODE_PROVIDERS.has(primary.provider)) {
    return true;
  }
  const allow = cfg.agents?.defaults?.modelPolicy?.allow;
  if (!Array.isArray(allow)) {
    return false;
  }
  return allow.some(
    (entry) =>
      typeof entry === "string" && LOCAL_CODE_MODE_PROVIDERS.has(providerFromModelRef(entry)),
  );
}

/** Collect advisory doctor warnings for code mode + local providers. */
export function collectCodeModeLocalWarnings(cfg: OpenClawConfig): string[] {
  if (!isCodeModeEnabled(cfg.tools?.codeMode)) {
    return [];
  }
  if (!configTouchesLocalCodeModeProviders(cfg)) {
    return [];
  }
  return [CODE_MODE_LOCAL_WARNING];
}
