import { AsyncLocalStorage } from "node:async_hooks";
import { MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { SqliteCoordinatorError } from "./sqlite-coordinator.js";

type DelegateIdentity = { actorId: string; coordinatorPath: string };

export function createCoordinatorDelegate(
  identity: DelegateIdentity,
  live: Int32Array,
  retained: { readonly closed: boolean; release(): void },
  revoke: () => void,
  label: string,
) {
  let channel: MessageChannel | undefined;
  let revoked = false;
  return {
    // The broker records this owner before channel allocation or publication can fail.
    get port() {
      if (revoked) {
        throw new SqliteCoordinatorError(`${label} is closed`);
      }
      if (!channel) {
        channel = new MessageChannel();
        channel.port1.postMessage({ ...identity, live: live.buffer });
        channel.port1.unref();
      }
      return channel.port2;
    },
    get closed() {
      return revoked && retained.closed;
    },
    release() {
      if (!revoked) {
        revoked = true;
        revoke();
        channel?.port1.close();
        channel?.port2.close();
      }
      retained.release();
    },
  };
}

export async function attachCoordinatorDelegate(
  port: MessagePort,
  identity: DelegateIdentity,
  label: string,
) {
  let closed = false;
  port.once("close", () => {
    closed = true;
  });
  const live = await new Promise<Int32Array>((resolve, reject) => {
    const onClose = () => {
      port.off("message", onMessage);
      reject(new SqliteCoordinatorError(`${label} closed before admission`));
    };
    const onMessage = (message: unknown) => {
      port.off("message", onMessage);
      port.off("close", onClose);
      if (
        !isRecord(message) ||
        message.actorId !== identity.actorId ||
        message.coordinatorPath !== identity.coordinatorPath ||
        !(message.live instanceof SharedArrayBuffer) ||
        message.live.byteLength !== Int32Array.BYTES_PER_ELEMENT
      ) {
        port.close();
        reject(new SqliteCoordinatorError(`${label} does not match its actor`));
        return;
      }
      resolve(new Int32Array(message.live));
    };
    port.once("close", onClose);
    port.once("message", onMessage);
    const queued = receiveMessageOnPort(port);
    if (queued) {
      onMessage(queued.message);
    }
  });
  port.unref();
  return {
    assertCurrent(this: void) {
      if (closed || Atomics.load(live, 0) !== 1) {
        throw new SqliteCoordinatorError(`${label} is no longer current`);
      }
    },
    close(this: void) {
      closed = true;
      port.close();
    },
  };
}

const lifecycleScopes = resolveGlobalSingleton(
  Symbol.for("openclaw.stateDatabaseLifecycleDelegateScopes"),
  () => new AsyncLocalStorage<ReadonlyMap<string, { active: boolean; assertCurrent(): void }>>(),
);

export function acquireDelegatedLifecycleCoordinator(coordinatorPath: string) {
  const delegate = lifecycleScopes.getStore()?.get(coordinatorPath);
  if (!delegate) {
    return undefined;
  }
  if (!delegate.active) {
    throw new SqliteCoordinatorError("State lifecycle delegate scope is closed");
  }
  delegate.assertCurrent();
  let closed = false;
  return {
    path: coordinatorPath,
    get closed() {
      return closed;
    },
    release() {
      closed = true;
    },
  };
}

export async function attachLifecycleCoordinatorDelegate(
  port: MessagePort,
  identity: DelegateIdentity,
) {
  const delegate = await attachCoordinatorDelegate(port, identity, "State lifecycle delegate");
  return {
    run<T>(operation: () => T): T {
      const scope = { active: true, assertCurrent: delegate.assertCurrent };
      const scopes = new Map(lifecycleScopes.getStore());
      scopes.set(identity.coordinatorPath, scope);
      const settled = () => {
        scope.active = false;
      };
      try {
        const result = lifecycleScopes.run(scopes, operation);
        if (result instanceof Promise) {
          void result.then(settled, settled);
        } else {
          settled();
        }
        return result;
      } catch (error) {
        settled();
        throw error;
      }
    },
    close: delegate.close,
  };
}
