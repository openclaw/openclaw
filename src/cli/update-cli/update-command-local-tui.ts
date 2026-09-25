import {
  announceLocalTuiUpdate,
  quiesceLocalTuiProcessesBeforeUpdate,
} from "../../infra/local-tui-processes.js";
import { resolveOpenClawInstallationId } from "../../infra/openclaw-installation-id.js";
import { defaultRuntime } from "../../runtime.js";

/** Announces activation, acquires every installation gate, and returns transaction cleanup. */
export async function acquireUpdateLocalTuiGate(
  roots: readonly string[],
  jsonMode: boolean,
  assertCurrent: () => void,
): Promise<() => Promise<void>> {
  const rootsByInstallation = new Map<string, string>();
  for (const root of roots) {
    const installationId = resolveOpenClawInstallationId(root);
    if (!rootsByInstallation.has(installationId)) {
      rootsByInstallation.set(installationId, root);
    }
  }
  const uniqueRoots = [...rootsByInstallation.values()];
  const gates: Awaited<ReturnType<typeof quiesceLocalTuiProcessesBeforeUpdate>>[] = [];
  const announcement = await announceLocalTuiUpdate(uniqueRoots);
  try {
    for (const root of uniqueRoots) {
      gates.push(await quiesceLocalTuiProcessesBeforeUpdate(root, { assertCurrent }));
    }
  } catch (error) {
    const releaseErrors: unknown[] = [];
    for (const gate of gates.toReversed()) {
      try {
        await gate.release();
      } catch (releaseError) {
        releaseErrors.push(releaseError);
      }
    }
    try {
      await announcement.release();
    } catch (releaseError) {
      releaseErrors.push(releaseError);
    }
    if (releaseErrors.length > 0) {
      throw new AggregateError(
        [error, ...releaseErrors],
        "Local TUI update gate acquisition failed and acquired gates could not be released",
        { cause: error },
      );
    }
    throw error;
  }
  const stopped = gates.flatMap((gate) => gate.stopped);
  if (!jsonMode && stopped.length) {
    defaultRuntime.log(
      `Stopped local TUI clients before replacing runtime files: ${stopped.join(", ")}`,
    );
  }
  for (const warning of gates.flatMap((gate) => gate.warnings)) {
    defaultRuntime[jsonMode ? "error" : "log"](warning);
  }
  return async () => {
    const releaseErrors: unknown[] = [];
    for (const gate of gates.toReversed()) {
      try {
        await gate.release();
      } catch (error) {
        releaseErrors.push(error);
      }
    }
    try {
      await announcement.release();
    } catch (error) {
      releaseErrors.push(error);
    }
    if (releaseErrors.length > 0) {
      throw new AggregateError(releaseErrors, "Local TUI update gates could not be released");
    }
  };
}
