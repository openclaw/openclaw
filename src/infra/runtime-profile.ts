import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { isEmbeddedStandaloneModule } from "../../cli-invocation.mjs";
import { getRuntimeExecutionProfile } from "../../standalone-runtime-profile.mjs";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export {
  getRuntimeExecutionProfile,
  type RuntimeExecutionProfile,
} from "../../standalone-runtime-profile.mjs";
export type RuntimeDynamicExecutionFeature = "plugins" | "code-mode" | "qa";

const features = {
  plugins: { bit: 1, label: "Fetched plugin code" },
  "code-mode": { bit: 2, label: "Node Code Mode" },
  qa: { bit: 4, label: "QA expression code" },
} satisfies Record<RuntimeDynamicExecutionFeature, { bit: number; label: string }>;

// Workers inherit the shared bitmap before executing plugin or Code Mode code.
// Duplicate SDK modules use the same slot; a reload must not repeat these notices.
const notices = resolveGlobalSingleton(Symbol.for("openclaw.runtimeExecutionNotices"), () => {
  const key = "openclaw.runtimeExecutionNotices";
  const inherited: unknown = getEnvironmentData(key);
  const buffer = inherited instanceof SharedArrayBuffer ? inherited : new SharedArrayBuffer(4);
  setEnvironmentData(key, buffer);
  return new Int32Array(buffer);
});

/** Performance information only; trust and execution authority stay with their owners. */
export function noteRuntimeDynamicExecution(feature: RuntimeDynamicExecutionFeature): void {
  if (getRuntimeExecutionProfile() !== "embedded-aot") {
    return;
  }
  const { bit, label } = features[feature];
  if ((Atomics.or(notices, 0, bit) & bit) === 0) {
    process.emitWarning(
      `${label} runs interpreted in this AOT build; use a JIT build for full speed.`,
      {
        code: "AOT_INTERPRETED",
      },
    );
  }
}

export function noteRuntimePluginExecution(modulePath: string): void {
  if (getRuntimeExecutionProfile() === "embedded-aot" && !isEmbeddedStandaloneModule(modulePath)) {
    noteRuntimeDynamicExecution("plugins");
  }
}

/** Add guidance only after the runtime actually rejects code or cannot find a module. */
export function annotateRuntimeExecutionError(error: unknown, feature: string): unknown {
  const message = formatErrorMessage(error);
  let guidance: string;
  if (/code generation from strings disallowed/i.test(message)) {
    guidance =
      "Runtime code generation is disabled. Use a Node/Bun or JIT build without " +
      "--disallow-code-generation-from-strings (including =strict).";
  } else if (
    getRuntimeExecutionProfile() === "embedded-aot" &&
    /(?:not in this executable|not compiled into this executable|isn't in this executable|cannot find (?:module|package)|cannot resolve (?:module|package)|cannot load module)/i.test(
      message,
    )
  ) {
    guidance =
      "This module is not available in this AOT build. Install missing code on disk through the plugin loader, " +
      "or rebuild the complete standalone artifact with the module. Use a JIT build for unrestricted runtime imports.";
  } else {
    return error;
  }
  return new Error(`${feature}: ${message} ${guidance}`, { cause: error });
}
