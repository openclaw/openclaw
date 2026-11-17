import { randomUUID } from "node:crypto";
import { MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { throwCollectedErrors } from "../infra/error-graph-internal.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import {
  decodeNativeWorkerFailure,
  encodeNativeWorkerFailure,
} from "../infra/worker-native-error.js";
import type { RetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import type { NativeWorkerResourceConnection } from "../infra/worker-native-lifecycle.types.js";
import { nativePortIsOpen } from "../infra/worker-native-port.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  PLUGIN_CAPTURE_RESOURCE_PORT,
  type PluginCaptureResourceCommand,
  type PluginCaptureResourceReply,
  type PluginCaptureResourceRoot,
  type PluginCaptureRootAnnouncement,
} from "./plugin-capture-native-resource.types.js";
import { markPluginSourceAcquisitionError } from "./plugin-instance-error.js";
import type { PluginSourceCaptureStorage } from "./plugin-instance-invocation.types.js";
import type { PluginNativeCaptureRoot } from "./plugin-native-root-lease.js";
import { subscribePluginNativeLoads } from "./plugin-source-capture-native-loads.js";

export function createPluginCaptureResourceClient(
  port: MessagePort,
  retainBrokerUntilProcessExit?: () => void,
) {
  const pending = new Map<
    number,
    {
      completion: ReturnType<typeof createDeferredCore<PluginCaptureResourceReply>>;
      reply?: PluginCaptureResourceReply;
    }
  >();
  let nextId = 0;
  let unavailable: Error | undefined;
  const receive = (reply: PluginCaptureResourceReply) => {
    const call = pending.get(reply.id);
    if (call) {
      if (reply.ok && reply.retainBrokerUntilProcessExit) {
        retainBrokerUntilProcessExit?.();
      }
      call.reply = reply;
      call.completion.resolve(reply);
    }
  };
  const fail = () => {
    unavailable ??= new Error("Plugin capture custody transport is unavailable");
    for (const call of pending.values()) {
      call.completion.reject(unavailable);
    }
    return unavailable;
  };
  port.on("message", receive);
  port.on("close", fail);
  port.on("messageerror", fail);
  const start = (command: PluginCaptureResourceCommand) => {
    if (unavailable) {
      throw unavailable;
    }
    const id = ++nextId;
    const call: {
      completion: ReturnType<typeof createDeferredCore<PluginCaptureResourceReply>>;
      reply?: PluginCaptureResourceReply;
    } = { completion: createDeferredCore() };
    void call.completion.promise.catch(() => {});
    pending.set(id, call);
    port.postMessage({ id, command });
    return { id, call };
  };
  const unwrap = (reply: PluginCaptureResourceReply) => {
    if (!reply.ok) {
      const error = decodeNativeWorkerFailure(reply.error);
      throw reply.sourceAcquisitionFailure ? markPluginSourceAcquisitionError(error) : error;
    }
    return reply;
  };
  return {
    async request(command: PluginCaptureResourceCommand) {
      const { id, call } = start(command);
      try {
        return unwrap(await call.completion.promise).root;
      } finally {
        pending.delete(id);
      }
    },
    requestSync(command: PluginCaptureResourceCommand) {
      const { id, call } = start(command);
      const pause = new Int32Array(new SharedArrayBuffer(4));
      try {
        while (!call.reply) {
          const next = receiveMessageOnPort(port);
          if (next) {
            receive(next.message);
          } else {
            if (!nativePortIsOpen(port)) {
              throw fail();
            }
            Atomics.wait(pause, 0, 0, 2);
          }
        }
        return unwrap(call.reply).root;
      } finally {
        pending.delete(id);
      }
    },
  };
}

/** Independent custody and execution relay share one physical plugin capture owner. */
export async function createPluginCaptureOwner(
  source: RetainedNativeWorkerSource,
  callbacks: {
    native(captureId: number, root: PluginNativeCaptureRoot): PluginCaptureResourceRoot;
  },
) {
  const owner = randomUUID();
  const moduleUrl = resolveRuntimeProcessEntrypointUrl("pluginCaptureNativeResource");
  const independent = await source.captureIndependentResource(moduleUrl, { owner, role: "owner" });
  const client = createPluginCaptureResourceClient(
    independent.port,
    independent.retainBrokerUntilProcessExit,
  );
  const roots = new Set<number>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const closeWhenReleased = () => {
    if (closing && !roots.size) {
      loaded();
      closePromise ??= independent.close();
      return closePromise;
    }
    return Promise.resolve();
  };
  const loaded = subscribePluginNativeLoads((filename) => {
    void client
      .request({ type: "loaded", filename })
      .catch((error: unknown) => process.emitWarning(String(error)));
  });
  const connect = (): NativeWorkerResourceConnection => {
    const { port1, port2 } = new MessageChannel();
    const receive = (announcement: PluginCaptureRootAnnouncement & { id: number }) => {
      const rootId = announcement.root.id;
      roots.add(rootId);
      let disposed: Promise<void> | undefined;
      let committed: Promise<void> | undefined;
      const dispose = () =>
        (disposed ??= (async () => {
          const errors: unknown[] = [];
          try {
            await committed;
          } catch (error) {
            errors.push(error);
          }
          try {
            await client.request({ type: "release-native", rootId });
            roots.delete(rootId);
            await closeWhenReleased();
          } catch (error) {
            errors.push(error);
          }
          throwCollectedErrors(errors, "Plugin native capture retirement failed");
        })());
      const root = {
        directory: announcement.root.directory,
        commit() {
          committed ??= client.request({ type: "commit-native", rootId }).then(() => {});
          void committed.catch(() => {});
          return committed;
        },
        dispose() {
          void dispose().catch((error: unknown) => process.emitWarning(String(error)));
        },
        disposeAsync: dispose,
      };
      let reply: PluginCaptureResourceReply;
      try {
        reply = {
          id: announcement.id,
          ok: true,
          root: callbacks.native(announcement.captureId, root),
        };
      } catch (error) {
        roots.delete(rootId);
        reply = {
          id: announcement.id,
          ok: false,
          error: encodeNativeWorkerFailure(error),
        };
      }
      port1.postMessage(reply);
    };
    port1.on("message", receive);
    return {
      port: port2,
      service() {
        for (;;) {
          const next = receiveMessageOnPort(port1);
          if (!next) {
            return;
          }
          receive(next.message);
        }
      },
      dispose() {
        port1.close();
        port2.close();
      },
    };
  };
  return {
    descriptor: source.captureResource(
      moduleUrl,
      PLUGIN_CAPTURE_RESOURCE_PORT,
      { owner, role: "execution" },
      connect,
    ),
    async createSource(captureId: number, storage: PluginSourceCaptureStorage, prefix: string) {
      const root = await client.request({ type: "source", captureId, storage, prefix });
      if (!root) {
        throw new Error("Plugin capture owner returned no source root");
      }
      return root;
    },
    releaseSource: (captureId: number) =>
      client.request({ type: "release-source", captureId }).then(() => {}),
    async close() {
      closing = true;
      await closeWhenReleased();
    },
  };
}
