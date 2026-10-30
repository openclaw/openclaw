import fs from "node:fs/promises";
import path from "node:path";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type {
  NodeBootstrapArtifact,
  NodeBootstrapArtifactOptions,
} from "./node-bootstrap-artifact-contract.js";
import { prepareNodeArtifactInWorker } from "./node-bootstrap-artifact-worker.js";
import { prepareNodeBootstrapInstallLock } from "./node-bootstrap-install-lock.js";

/** Owns one immutable deployment artifact for this Gateway process, never the live installation. */
export function createNodeBootstrapArtifactProvider(options: NodeBootstrapArtifactOptions) {
  let prepared: Promise<NodeBootstrapArtifact> | undefined;
  let temporaryRoot: string | undefined;
  let closed = false;
  return {
    async prepare(signal?: AbortSignal): Promise<NodeBootstrapArtifact> {
      signal?.throwIfAborted();
      if (closed) {
        throw new Error("Node bootstrap artifact provider is closed");
      }
      // Assign the shared promise before synchronous scratch-root failures can clear it.
      prepared ??= Promise.resolve().then(async () => {
        try {
          temporaryRoot = await fs.mkdtemp(
            path.join(resolvePreferredOpenClawTmpDir(), "openclaw-node-runtime-"),
          );
          const artifact = await prepareNodeArtifactInWorker("bootstrap", {
            options,
            temporaryRoot,
          });
          return { ...artifact, installLock: await prepareNodeBootstrapInstallLock(artifact) };
        } catch (error) {
          if (temporaryRoot) {
            await fs.rm(temporaryRoot, { recursive: true, force: true });
          }
          temporaryRoot = undefined;
          prepared = undefined;
          throw error;
        }
      });
      // Cancellation releases this consumer; process shutdown still drains the shared producer.
      return racePromiseWithAbortSignal(prepared, signal);
    },
    async close(): Promise<void> {
      closed = true;
      await prepared?.catch(() => undefined);
      // Enrollment overlapping a plugin reload may retry with the new producer.
      if (temporaryRoot) {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
        temporaryRoot = undefined;
      }
    },
  };
}
