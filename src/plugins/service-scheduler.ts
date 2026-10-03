import { randomUUID } from "node:crypto";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { runInDetachedAsyncContext } from "../shared/async-work-scope.js";
import { withPluginServiceScheduler } from "./service-scheduler-binding.js";
import type { PluginServiceSchedulerV1 } from "./service-scheduler.types.js";

export type PluginServiceSchedulerOwner = {
  scheduler: PluginServiceSchedulerV1;
  close: () => Promise<void> | undefined;
};

export function createPluginServiceScheduler(
  scheduler: GatewayScheduler,
  runOwned?: (run: () => void | Promise<unknown>) => void | Promise<unknown>,
): PluginServiceSchedulerOwner {
  const createScope = (parent?: Set<PluginServiceSchedulerOwner>): PluginServiceSchedulerOwner => {
    const owner = scheduler.scope();
    const prefix = `plugin-service:${randomUUID()}:`;
    const children = new Set<PluginServiceSchedulerOwner>();
    let stopping: Promise<void> | undefined;
    const assertOpen = () => {
      if (owner.signal.aborted) {
        throw new Error("Plugin service scheduler is closed");
      }
    };
    const beginClose = () => {
      owner.beginClose();
      for (const child of children) {
        child.scheduler.beginClose();
      }
    };
    const close = (): Promise<void> | undefined => {
      const pending = [owner.close(), ...Array.from(children, (child) => child.close())].filter(
        (completion) => completion !== undefined,
      );
      if (pending.length === 0) {
        parent?.delete(control);
        return undefined;
      }
      stopping ??= Promise.all(pending)
        .then(() => undefined)
        .finally(() => parent?.delete(control));
      return stopping;
    };
    const scope: PluginServiceSchedulerV1 = {
      version: 1,
      signal: owner.signal,
      now: owner.now,
      schedule: (params) => {
        assertOpen();
        const schedule = () =>
          owner.schedule({
            ...params,
            id: `${prefix}${params.id}`,
            run: () =>
              withPluginServiceScheduler(scope, () =>
                runOwned ? runOwned(params.run) : params.run(),
              ),
          });
        return runOwned ? runInDetachedAsyncContext(schedule) : schedule();
      },
      scope: () => {
        assertOpen();
        const child = createScope(children);
        children.add(child);
        return child.scheduler;
      },
      beginClose,
      stop: () => (stopping ??= Promise.resolve(close())),
    };
    const control: PluginServiceSchedulerOwner = { scheduler: scope, close };
    return control;
  };
  return createScope();
}
