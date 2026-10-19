import { receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { serveOwnedWorkerTasks } from "../infra/worker-task-server.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import { createPluginCaptureResolver } from "./plugin-capture-resolution.js";
import { createPluginGenerationArtifact } from "./plugin-generation-capture.js";
import type { PluginGenerationCaptureState } from "./plugin-generation-capture.types.js";
import type {
  GenerationWorkerInput,
  GenerationWorkerReply,
  GenerationWorkerCallback,
} from "./plugin-generation-worker-contract.js";
import {
  nativeAdmissionStateFor,
  settlePluginNativeAdmissions,
} from "./plugin-native-admission-state.js";
import { createPluginSourceCapture } from "./plugin-package-metadata-capture.js";
import { withPluginSourceAdmissionPublisher } from "./plugin-source-admission-context.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

function createHostCallbacks(port: MessagePort) {
  let nextId = 0;
  return (
    request:
      | { kind: "resolution-policy"; source: string }
      | { kind: "resolve"; source: string; reference: string; conditions: readonly string[] }
      | { kind: "native-root" },
  ): Extract<GenerationWorkerCallback, { kind: "callback-result" }> => {
    const id = ++nextId;
    const signal = new Int32Array(new SharedArrayBuffer(4));
    port.postMessage({ ...request, id, signal } satisfies GenerationWorkerCallback);
    const deadline = performance.now() + 15_000;
    for (;;) {
      // SAFETY: This private port is transferred by the matching preparation owner.
      const message = receiveMessageOnPort(port)?.message as GenerationWorkerCallback | undefined;
      if (message?.kind === "callback-result" && message.id === id) {
        if (message.error) {
          throw Object.assign(new Error(message.error.message), message.error);
        }
        return message;
      }
      if (performance.now() > deadline) {
        throw new Error("Plugin preparation callback timed out");
      }
      Atomics.wait(signal, 0, 0, 2);
    }
  };
}

serveOwnedWorkerTasks<GenerationWorkerReply, GenerationWorkerInput>(async (command) =>
  // Initial capture never owns publication. The host adopts intent and native custody
  // before retiring this worker; all later materialization runs in that host owner.
  withPluginSourceAdmissionPublisher(
    async () => false,
    () =>
      withPluginInstallRoots(command.installRoots, () =>
        withPluginSourceCaptureStorage(command.storage, () => {
          const capture = async (): Promise<GenerationWorkerReply> => {
            const host = createHostCallbacks(command.callbackPort);
            const admission = nativeAdmissionStateFor();
            const rootIds = new WeakMap<object, number>();
            admission.createRoot = () => {
              const reference = host({ kind: "native-root" }).root;
              if (!reference) {
                throw new Error("Plugin preparation host did not allocate native custody");
              }
              const root = {
                directory: reference.directory,
                commit() {},
                dispose() {},
                async disposeAsync() {},
              };
              rootIds.set(root, reference.id);
              return root;
            };
            for (const key of [
              "owners",
              "managedRoots",
              "receipts",
              "files",
              "namespaces",
            ] as const) {
              const target: Map<string, unknown> = admission[key];
              for (const [name, value] of command.admission[key]) {
                target.set(name, value);
              }
            }
            let transforms: ReturnType<typeof createPluginCaptureResolver> | undefined;
            const policies = new Map<string, boolean>();
            const policy = (source: string) => {
              if (!policies.has(source)) {
                const options = host({ kind: "resolution-policy", source }).options!;
                policies.set(source, Boolean(options.tsconfigPaths));
                // Jiti applies explicit options after its environment defaults. Only the
                // host owns tsconfig discovery; this worker uses Jiti for transformation.
                transforms ??= createPluginCaptureResolver({ ...options, tsconfigPaths: false });
              }
              return policies.get(source)!;
            };
            try {
              let state: PluginGenerationCaptureState | undefined;
              createPluginGenerationArtifact(
                command.rootDir,
                command.entryFile,
                (run) => run(),
                undefined,
                undefined,
                undefined,
                undefined,
                false,
                {
                  prepared: (value) => {
                    state = value;
                  },
                  admission,
                  sourceCapture: createPluginSourceCapture(command.sourceCapture),
                  resolution: {
                    hasTsconfigPaths: policy,
                    get(source) {
                      policy(source);
                      return transforms!.get(source);
                    },
                    resolve: (source, reference, conditions) =>
                      host({ kind: "resolve", source, reference, conditions }).resolved,
                    clear: () => transforms?.clear(),
                  },
                },
              );
              await settlePluginNativeAdmissions();
              const receipts = new Map(
                [...admission.receipts].filter(
                  ([key, receipt]) => command.admission.receipts.get(key) !== receipt,
                ),
              );
              const directories = new Set(
                [...receipts.values()].flatMap((receipt) => Object.keys(receipt.nativeNamespaces)),
              );
              return {
                state: state!,
                admission: {
                  receipts,
                  roots: [...admission.roots]
                    .filter((root) => directories.has(root.directory))
                    .map((root) => rootIds.get(root)!),
                  publications: [...admission.publications.values()].map(({ data }) => data),
                },
              };
            } catch (error) {
              const failure = error instanceof Error ? error : new Error(String(error));
              return {
                error: { message: failure.message, name: failure.name, stack: failure.stack },
              };
            } finally {
              command.callbackPort.close();
            }
          };
          return command.readOnly ? withArtifactPreservingStateReads(capture) : capture();
        }),
      ),
  ),
);
