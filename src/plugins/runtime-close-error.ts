import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type PluginRuntimeCloseChildDiagnostics = {
  pluginId?: string;
  pid?: number;
  argv0?: string;
  command?: string;
  pending: {
    closingReceipt: boolean;
    controlClose: boolean;
    relayExit: boolean;
    stdoutEnd: boolean;
    stderrEnd: boolean;
    lineageEof: boolean;
    extinctionUnconfirmed: boolean;
  };
};

// Source Gateway owners and compiled SDK claims share cleanup custody and error identity.
export const PluginRuntimeCloseRetainedError = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginRuntimeCloseRetainedError"),
  () =>
    class RetainedRuntimeError extends Error {
      readonly diagnostics?: PluginRuntimeCloseChildDiagnostics;

      constructor(cause: unknown, diagnostics?: PluginRuntimeCloseChildDiagnostics) {
        super(
          "Plugin runtime still owns resources; inspect cleanup failures before retrying Gateway close.",
          { cause },
        );
        this.name = "PluginRuntimeCloseRetainedError";
        this.diagnostics = diagnostics;
      }
    },
);

export type PluginRuntimeCloseRetainedError = InstanceType<typeof PluginRuntimeCloseRetainedError>;

export function hasRetainedPluginRuntimeCloseError(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some(
    (candidate) => candidate instanceof PluginRuntimeCloseRetainedError,
  );
}
