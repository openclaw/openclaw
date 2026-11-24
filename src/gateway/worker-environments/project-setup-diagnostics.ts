import { z } from "zod";
import { createSubsystemLogger } from "../../logging/subsystem.js";

// Closed values from the existing TEAMCLAW_SETUP_V1 emitters; repository markers
// are observations, never trusted helper identity or lifecycle authority.
export const SETUP_MARKER_STAGES = [
  "node_probe",
  "node_install",
  "node_validation",
  "package_prerequisites",
  "helper_projection",
  "rust_setup",
  "azure_cli_setup",
  "azure_version",
  "azure_package",
  "azure_payload",
  "azure_install",
  "azure_identity",
  "azure_credential",
  "env_load",
  "credential_acquisition",
  "msrustup_probe",
  "msrustup_install",
  "toolchain_probe",
  "toolchain_install",
  "provenance",
  "compiler_probe",
  "formatter_probe",
  "clippy_probe",
  "credential_transport",
  "setup_contract",
  "build_pins",
  "rust_toolchain",
  "native_prerequisites",
  "python_validators",
  "mcp_dependencies",
  "cargo_providers",
  "optional_caches",
  "repository_channel",
] as const;
export const SETUP_NATIVE_STAGES = [
  "setup",
  "initializer",
  "onCreate",
  "updateContent",
  "detectedInstall",
  "postCreate",
  "postStart",
  "lifecycle",
] as const;
export const SETUP_MARKER_REASONS = [
  "unsupported_command",
  "repository_root_invalid",
  "repository_git_unavailable",
  "setup_inputs_unsupported",
  "setup_child_spawn_failed",
  "setup_child_signal",
  "setup_child_status_unavailable",
] as const;
export const SETUP_FAILURE_REASONS = [
  "nonzero_exit",
  "signal",
  "spawn_failed",
  "timeout",
  "interrupted",
  "invalid_environment",
  "output_limit",
  "budget_exhausted",
] as const;
export const SETUP_SIGNALS = [
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGSEGV",
  "SIGPIPE",
  "SIGTERM",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGSYS",
  "unknown",
] as const;
const Event = z
  .object({
    origin: z.enum(["native", "initializer", "repository"]),
    stage: z.enum([...SETUP_MARKER_STAGES, ...SETUP_NATIVE_STAGES]),
    phase: z.enum(SETUP_NATIVE_STAGES).optional(),
    outcome: z.enum(["started", "succeeded", "failed"]),
    exit: z.number().int().min(0).max(255).optional(),
    signal: z.enum(SETUP_SIGNALS).optional(),
    elapsedMs: z.number().int().min(0).max(2147483647).optional(),
    reason: z.enum([...SETUP_FAILURE_REASONS, ...SETUP_MARKER_REASONS]).optional(),
  })
  .strict();
const Diagnostics = z
  .object({
    schema: z.literal("openclaw.setup-diagnostics.v1"),
    events: z.array(Event).max(32),
    truncatedEvents: z.number().int().nonnegative(),
    outputTail: z.string().optional(),
  })
  .strict();
const log = createSubsystemLogger("gateway/worker-project");

/** Log only closed facts; return a validated ordinary tail for the caller's existing error display. */
export function logWorkerSetupFailure(output: string | undefined): string | undefined {
  if (!output || Buffer.byteLength(output) > 16384) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return output;
  }
  const result = Diagnostics.safeParse(value);
  if (result.success) {
    const { outputTail, ...safe } = result.data;
    log.error(`Worker project setup failed: ${JSON.stringify(safe)}`);
    return outputTail;
  }
  // Existing custom providers can still report an ordinary bounded stderr tail.
  return output;
}
