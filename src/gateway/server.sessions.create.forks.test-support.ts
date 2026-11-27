import { onTestFinished } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";

export const forkableClaudeCliBackend = {
  id: "claude-cli",
  pluginId: "anthropic",
  modelProvider: "anthropic",
  config: { command: "claude", forkArg: "--fork-session", resumeAtArg: "--resume-session-at" },
  bundleMcp: false,
  ownsNativeCompaction: false,
} satisfies ReturnType<
  (typeof import("../plugins/cli-backends.runtime.js"))["resolveRuntimeCliBackends"]
>[number];

export function registerForkableCliBackend() {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [forkableClaudeCliBackend],
    resolvePluginSetupCliBackend: () => undefined,
  });
  onTestFinished(() => cliBackendsTesting.resetDepsForTest());
}
