import fs from "node:fs/promises";
import path from "node:path";
import { racePromiseWithAbortSignal, waitForAbortSignal } from "../../infra/abort-signal.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type {
  NodeBootstrapArtifact,
  NodeBootstrapArtifactOptions,
} from "./node-bootstrap-artifact-contract.js";
import { prepareNodeBootstrapArtifactInWorker } from "./node-bootstrap-artifact-worker.js";

/** Owns one immutable deployment artifact for this Gateway process, never the live installation. */
export function createNodeBootstrapArtifactProvider(options: NodeBootstrapArtifactOptions) {
  let prepared: Promise<NodeBootstrapArtifact> | undefined;
  let temporaryRoot: string | undefined;
  let closed = false;
  const consumers = new Map<AbortSignal, Promise<void>>();
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
          if (closed) {
            throw new Error("Node bootstrap artifact provider is closed");
          }
          const artifact = await prepareNodeBootstrapArtifactInWorker(options, temporaryRoot);
          if (closed) {
            throw new Error("Node bootstrap artifact provider is closed");
          }
          return artifact;
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
      const artifact = await racePromiseWithAbortSignal(prepared, signal);
      signal?.throwIfAborted();
      if (closed) {
        throw new Error("Node bootstrap artifact provider is closed");
      }
      // A registry reload retires the producer, but an admitted enrollment still owns
      // its artifact until that enrollment's authority closes.
      if (signal && !consumers.has(signal)) {
        consumers.set(
          signal,
          waitForAbortSignal(signal).then(() => {
            consumers.delete(signal);
          }),
        );
      }
      return artifact;
    },
    async close(): Promise<void> {
      closed = true;
      await prepared?.catch(() => undefined);
      await Promise.all(consumers.values());
      if (temporaryRoot) {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
        temporaryRoot = undefined;
      }
    },
  };
}
