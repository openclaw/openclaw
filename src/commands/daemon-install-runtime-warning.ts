import { renderSystemNodeWarning, resolveSystemNodeInfo } from "../daemon/runtime-paths.js";

export type DaemonInstallWarnFn = (message: string, title?: string) => void;

/** Emits install-time warnings when the selected Node runtime differs from the system runtime. */
export async function emitNodeRuntimeWarning(params: {
  env: Record<string, string | undefined>;
  runtime: string;
  nodeProgram?: string;
  warn?: DaemonInstallWarnFn;
  title: string;
}): Promise<void> {
  if (params.runtime !== "node") {
    return;
  }
  const systemNode = await resolveSystemNodeInfo({ env: params.env });
  // The warning renderer compares the launch/runtime Node with the system Node
  // that service managers may discover later.
  const warning = renderSystemNodeWarning(systemNode, params.nodeProgram);
  if (warning) {
    params.warn?.(warning, params.title);
  }
}
