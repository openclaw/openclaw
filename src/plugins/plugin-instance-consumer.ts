import { createDeferredCore } from "../shared/deferred.js";
import type {
  PluginInstanceConsumer,
  PluginRetentionOwner,
  PluginRetentionReason,
} from "./plugin-instance.types.js";
import type { PluginReferenceDiagnostics } from "./plugin-retention-diagnostics.js";
import type { PluginRegistry } from "./registry-types.js";

type ConsumerToken = {
  active: boolean;
  completion: Promise<void>;
  registry?: PluginRegistry;
  kind: "work" | "custody";
};
type Run = <T>(run: () => T) => T;

/** Create one admitted consumer; physical completion alone releases its owner's token. */
export function createPluginInstanceConsumer({
  pluginId,
  registry,
  kind,
  consumers,
  waiters,
  diagnostics,
  parentToken,
  reason,
  owner,
  run: invoke,
  close,
  wrap,
}: {
  pluginId: string;
  registry?: PluginRegistry;
  kind: "work" | "custody";
  consumers: Map<object, ConsumerToken>;
  waiters: Set<() => void>;
  diagnostics: PluginReferenceDiagnostics;
  parentToken?: object;
  reason?: PluginRetentionReason;
  owner?: PluginRetentionOwner;
  run: <T>(token: ConsumerToken, run: () => T) => T;
  close: (token: ConsumerToken, cleanup: () => void | Promise<void>) => void | Promise<void>;
  wrap: (run: Run) => <T>(value: T) => T;
}): PluginInstanceConsumer {
  const released = createDeferredCore();
  const token: ConsumerToken = {
    active: true,
    completion: released.promise,
    registry,
    kind,
  };
  consumers.set(token, token);
  const reference = diagnostics.record(
    token,
    parentToken,
    kind === "custody" ? "custody" : "consumer",
    reason ?? "consumer",
    owner,
  );
  let closing: Promise<void> | undefined;
  const release = () => {
    token.active = false;
    if (consumers.delete(token)) {
      released.resolve();
      waiters.forEach((wake) => wake());
    }
  };
  const run: Run = (consume) => {
    if (!token.active) {
      throw new Error(`Plugin ${pluginId} consumer is closed`);
    }
    return invoke(token, consume);
  };
  return {
    run,
    wrap: wrap(run),
    close: (cleanup) => {
      if (!closing && consumers.has(token)) {
        // Close callbacks before separate host teardown; keep the physical hold until settlement.
        token.active = false;
        reference.cleanupState = "pending";
        const completion = createDeferredCore();
        closing = completion.promise.finally(release);
        try {
          completion.resolve(close(token, cleanup));
        } catch (error) {
          completion.reject(error);
        }
      }
      return closing ?? Promise.reject(new Error(`Plugin ${pluginId} consumer is closed`));
    },
    release: () => {
      if (!closing) {
        release();
      }
    },
  };
}
