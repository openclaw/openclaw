import { isPathInside } from "../infra/path-guards.js";
import {
  decodeNativeWorkerFailure,
  encodeNativeWorkerFailure,
} from "../infra/worker-native-error.js";
import type {
  NativeWorkerResourceOwner,
  NativeWorkerResourcePort,
} from "../infra/worker-native-lifecycle.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  PluginCaptureResourceInput,
  PluginCaptureResourceRequest,
  PluginCaptureResourceReply,
  PluginCaptureRootAnnouncement,
} from "./plugin-capture-native-resource.types.js";
import { isPluginSourceAcquisitionError } from "./plugin-instance-error.js";
import {
  createPluginNativeCaptureRoot,
  createPluginSourceCaptureRoot,
} from "./plugin-source-capture-directory.js";
import { recordPluginNativeLoad } from "./plugin-source-capture-native-loads.js";

type Domain = {
  sources: Map<number, ReturnType<typeof createPluginSourceCaptureRoot>>;
  roots: Map<
    number,
    {
      captureId: number;
      announced: boolean;
      root: ReturnType<typeof createPluginNativeCaptureRoot>;
    }
  >;
  nextRoot: number;
  borrowers: number;
};
// One physical token owner per domain; execution resources borrow it through the existing relay.
const domains = new Map<string, Domain>();

export function createNativeWorkerResource(
  port: NativeWorkerResourcePort,
  input: unknown,
  ownerPort?: NativeWorkerResourcePort,
): NativeWorkerResourceOwner {
  // SAFETY: Only the paired capture owner constructs this private resource input.
  const config = input as PluginCaptureResourceInput;
  let domain = domains.get(config.owner);
  if (config.role === "owner") {
    if (domain) {
      throw new Error("Plugin capture owner already exists");
    }
    domain = { sources: new Map(), roots: new Map(), nextRoot: 0, borrowers: 0 };
    domains.set(config.owner, domain);
  }
  if (!domain) {
    throw new Error("Plugin capture owner is unavailable");
  }
  const owned = domain;
  const sendOwnerMessage = ownerPort?.postMessage.bind(ownerPort);
  if (config.role === "execution") {
    owned.borrowers++;
  }
  const announcements = new Map<
    number,
    ReturnType<typeof createDeferredCore<PluginCaptureResourceReply>>
  >();
  ownerPort?.on("message", (value) => {
    // SAFETY: The host connection sends only replies to this resource's announcements.
    const reply = value as PluginCaptureResourceReply;
    announcements.get(reply.id)?.resolve(reply);
    announcements.delete(reply.id);
  });
  let closed = false;
  let available = true;
  port.on("close", () => {
    available = false;
  });
  let pending = Promise.resolve();
  const execute = async ({ id, command }: PluginCaptureResourceRequest) => {
    if (closed) {
      throw new Error("Plugin capture resource has closed");
    }
    if (command.type === "source") {
      const source = createPluginSourceCaptureRoot(
        command.storage.stateDir,
        command.prefix,
        command.storage.placement,
      );
      owned.sources.set(command.captureId, source);
      return {
        root: {
          id: command.captureId,
          directory: source.directory,
          managedRoot: source.managedRoot,
        },
      };
    }
    if (command.type === "native") {
      if (!sendOwnerMessage) {
        throw new Error("Plugin capture execution has no host owner");
      }
      const root = createPluginNativeCaptureRoot(
        command.storage.stateDir,
        command.storage.placement,
      );
      const rootId = ++owned.nextRoot;
      const retained = { captureId: command.captureId, announced: false, root };
      owned.roots.set(rootId, retained);
      const response = createDeferredCore<PluginCaptureResourceReply>();
      announcements.set(id, response);
      const announcement = {
        id,
        captureId: command.captureId,
        root: { id: rootId, directory: root.directory },
      } satisfies PluginCaptureRootAnnouncement & { id: number };
      sendOwnerMessage(announcement);
      const reply = await response.promise;
      if (!reply.ok) {
        throw decodeNativeWorkerFailure(reply.error);
      }
      retained.announced = true;
      return { root: reply.root };
    }
    if (command.type === "loaded") {
      recordPluginNativeLoad(command.filename);
      return {
        retainBrokerUntilProcessExit: [...owned.roots.values()].some(({ root }) =>
          isPathInside(root.directory, command.filename),
        ),
      };
    } else if (command.type === "release-source") {
      await owned.sources.get(command.captureId)?.release();
      owned.sources.delete(command.captureId);
      for (const [rootId, entry] of owned.roots) {
        if (entry.captureId === command.captureId && !entry.announced) {
          await entry.root.disposeAsync();
          owned.roots.delete(rootId);
        }
      }
    } else if (command.type === "commit-native") {
      const entry = owned.roots.get(command.rootId);
      if (!entry) {
        throw new Error("Plugin native capture has closed");
      }
      entry.root.commit();
    } else {
      await owned.roots.get(command.rootId)?.root.disposeAsync();
      owned.roots.delete(command.rootId);
    }
    return {};
  };
  const receive = (value: unknown) => {
    // SAFETY: The paired capture client is this private port's only producer.
    const request = value as PluginCaptureResourceRequest;
    pending = pending.then(async () => {
      let reply: PluginCaptureResourceReply;
      try {
        reply = { id: request.id, ok: true, ...(await execute(request)) };
      } catch (error) {
        reply = {
          id: request.id,
          ok: false,
          error: encodeNativeWorkerFailure(error),
          ...(isPluginSourceAcquisitionError(error)
            ? { sourceAcquisitionFailure: true as const }
            : {}),
        };
      }
      if (available) {
        try {
          port.postMessage(reply);
        } catch {
          available = false;
        }
      }
    });
  };
  port.on("message", receive);
  return {
    async close() {
      if (closed) {
        return;
      }
      await pending;
      if (config.role === "owner") {
        if (owned.borrowers || owned.sources.size || owned.roots.size) {
          throw new Error("Plugin capture owner still has retained resources");
        }
        domains.delete(config.owner);
      } else {
        owned.borrowers--;
      }
      closed = true;
      port.off("message", receive);
      port.close();
      ownerPort?.close();
    },
  };
}
