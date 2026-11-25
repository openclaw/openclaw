import type { CliBackendPlugin } from "./cli-backend.types.js";

export function warnOnMissingCliBackendModelProvider(
  backend: Pick<CliBackendPlugin, "id" | "modelProvider">,
  warn: (message: string) => void,
): void {
  if (!backend.modelProvider?.trim()) {
    warn(
      `cli backend "${backend.id.trim()}" is missing modelProvider; provider-to-runtime binding will be skipped. Set modelProvider to the canonical model provider id to enable this binding.`,
    );
  }
}
