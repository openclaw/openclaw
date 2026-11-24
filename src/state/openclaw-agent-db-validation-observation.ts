import { stat } from "node:fs/promises";
import path from "node:path";
import { observeOwnedDirectory } from "../infra/owned-directory-observation.js";
import { assertDatabaseFileIdentity } from "../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-facts.js";

const validationObservations = resolveGlobalSingleton<
  Map<string, { close(): void; revalidate(): Promise<void>; ready?: Promise<void> }>
>(Symbol.for("openclaw.agentDatabaseValidationObservations"), () => new Map());

export function createAgentValidationObservation(
  readValidation: (pathname: string) => OpenClawAgentDatabaseValidation | undefined,
  invalidate: (pathname: string, identity: string) => void,
) {
  function releaseValidationObservation(pathname: string): void {
    validationObservations.get(pathname)?.close();
  }

  function observeValidationPath(pathname: string, admission: boolean): Promise<void> | undefined {
    const existing = validationObservations.get(pathname);
    if (existing) {
      return admission ? existing.revalidate() : existing.ready;
    }
    const revalidate = async () => {
      const validation = readValidation(pathname);
      if (!validation || Atomics.load(new Int32Array(validation.valid), 0) !== 1) {
        return;
      }
      try {
        assertDatabaseFileIdentity(await stat(pathname, { bigint: true }), {
          key: `file:${validation.identity}`,
          birthtime: validation.birthtime,
        });
      } catch {
        if (readValidation(pathname) === validation) {
          invalidate(pathname, validation.identity);
        }
      }
    };
    const watched = observeOwnedDirectory(path.dirname(pathname), (filename, event) => {
      if (event === "change" && filename !== undefined) {
        return;
      }
      if (
        filename === undefined ||
        (process.platform === "win32"
          ? filename.toLowerCase() === path.basename(pathname).toLowerCase()
          : filename === path.basename(pathname))
      ) {
        void revalidate();
      }
    });
    // Retained proof outlives native handles; its cache owns observation cleanup.
    const ready = revalidate();
    validationObservations.set(pathname, {
      revalidate,
      ready,
      close() {
        watched.close();
        validationObservations.delete(pathname);
      },
    });
    // The first subscriber must not retain a file replaced before observation began.
    return ready.finally(() => {
      const observation = validationObservations.get(pathname);
      if (observation?.ready === ready) {
        delete observation.ready;
      }
    });
  }

  return { observe: observeValidationPath, release: releaseValidationObservation };
}
