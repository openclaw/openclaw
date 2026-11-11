import { AsyncLocalStorage } from "node:async_hooks";
import { onWorktreeTemplateActivity } from "../agents/worktrees/run-end-lifecycle.js";
import type { WorktreeTemplateRecipe } from "../agents/worktrees/template-prewarm.types.js";
import { worktreeTemplateMutationKey } from "../agents/worktrees/template-registry.js";
import { getRuntimeConfigSnapshotMetadata } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import { createHostIoPressureProbe } from "../infra/host-io-pressure.js";
import {
  isGatewayWorkAdmissionClosed,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";

const DEBOUNCE_MS = 30_000;

/** One bounded maintenance queue consumes base-owner facts; it never polls origin. */
export function startWorkspaceTemplatePrewarm(params: {
  scheduler: GatewaySchedulerScope;
  getConfig: () => OpenClawConfig;
  onError: (message: string) => void;
}): { stop: () => void } {
  const { scheduler } = params;
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const pressure = createHostIoPressureProbe();
  const active = new Map<
    string,
    {
      recipe: WorktreeTemplateRecipe;
      config: OpenClawConfig;
      publication: ReturnType<typeof getRuntimeConfigSnapshotMetadata>;
      head?: string;
      observed?: string;
      at?: number;
    }
  >();
  const foreground = new Map<string, number>();
  let busy = 0;
  let running:
    | { key: string; commit: string; selection?: string; controller: AbortController }
    | undefined;
  const servingForeground = () =>
    running?.selection !== undefined && foreground.has(running.selection);
  let stopped = false;
  const schedule = (retryDelay?: number) => {
    if (stopped || running || scheduler.signal.aborted) {
      return;
    }
    const at = Math.min(
      ...[...active.values()].filter((item) => item.head).map((item) => item.at!),
    );
    if (!Number.isFinite(at)) {
      return;
    }
    inOwnerContext(() =>
      scheduler.schedule({
        id: "maintenance:worktrees:template-prewarm",
        delayMs: retryDelay ?? Math.max(0, at - scheduler.now()),
        run: async () => {
          if (
            busy ||
            foreground.size ||
            isGatewayWorkAdmissionClosed() ||
            (await pressure()) ||
            busy ||
            foreground.size
          ) {
            schedule(DEBOUNCE_MS);
            return;
          }
          if (running) {
            return;
          }
          const entry = [...active.entries()].find(
            ([, item]) => item.head && (item.at ?? 0) <= scheduler.now(),
          );
          if (!entry) {
            schedule();
            return;
          }
          const [key, item] = entry;
          const commit = item.head!;
          item.head = undefined;
          if (
            item.config !== params.getConfig() ||
            item.publication !== getRuntimeConfigSnapshotMetadata() ||
            item.config.worktreeAcceleration === false
          ) {
            active.delete(key);
            schedule();
            return;
          }
          const controller = new AbortController();
          const signal = AbortSignal.any([controller.signal, scheduler.signal]);
          running = { key, commit, controller };
          try {
            await runWithGatewayIndependentRootWorkAdmission(
              async () => {
                const { prewarmWorkspaceTemplate } =
                  await import("./worker-environments/workspace-template-prewarm.js");
                return prewarmWorkspaceTemplate(item.recipe, commit, {
                  signal,
                  commitGuard: () => {
                    signal.throwIfAborted();
                    if (
                      stopped ||
                      item.config !== params.getConfig() ||
                      item.publication !== getRuntimeConfigSnapshotMetadata() ||
                      item.config.worktreeAcceleration === false
                    ) {
                      throw new Error("Template prewarm configuration changed");
                    }
                    if (foreground.size && !servingForeground()) {
                      controller.abort(new Error("Template prewarm yielded to a user preparation"));
                      signal.throwIfAborted();
                    }
                  },
                });
              },
              "runtime:template-prewarm",
              signal,
            );
          } catch (error) {
            if (!signal.aborted) {
              params.onError(`Template prewarm failed: ${String(error)}`);
            }
          } finally {
            running = undefined;
            schedule();
          }
        },
      }),
    );
  };
  const unsubscribe = onWorktreeTemplateActivity(process.env, (event) => {
    if (stopped || scheduler.signal.aborted) {
      return;
    }
    if (event.type === "preparation") {
      const selection =
        event.selection &&
        JSON.stringify([
          event.selection.cacheKey,
          event.selection.contentKey,
          event.selection.backend,
        ]);
      if (event.background) {
        if (running && event.selection?.cacheKey === running.key) {
          running.selection = event.active ? selection : undefined;
        }
        return;
      }
      if (selection) {
        const count = (foreground.get(selection) ?? 0) + (event.active ? 1 : -1);
        if (count > 0) {
          foreground.set(selection, count);
        } else {
          foreground.delete(selection);
        }
        const pending = running && active.get(running.key);
        if (
          running &&
          !servingForeground() &&
          (foreground.size || (pending?.head && pending.head !== running.commit))
        ) {
          if (pending && !pending.head) {
            pending.head = running.commit;
            pending.at = scheduler.now() + DEBOUNCE_MS;
          }
          running.controller.abort(new Error("Template prewarm yielded to a user preparation"));
        }
      } else {
        // Replacement subscribers can receive settlement without observing its start.
        busy = Math.max(0, busy + (event.active ? 1 : -1));
      }
      if (!busy && !foreground.size) {
        schedule();
      }
    } else if (event.type === "used") {
      const key = worktreeTemplateMutationKey(event.recipe.template.cacheKey);
      const previous = active.get(key);
      if (!previous && active.size >= 32) {
        return;
      }
      active.set(key, {
        ...previous,
        recipe: event.recipe,
        config: params.getConfig(),
        publication: getRuntimeConfigSnapshotMetadata(),
      });
    } else {
      for (const [key, item] of active) {
        if (item.recipe.template.commonDir !== event.commonDir || item.observed === event.commit) {
          continue;
        }
        item.observed = event.commit;
        item.head = event.commit;
        item.at = scheduler.now() + DEBOUNCE_MS;
        if (running?.key === key && running.commit !== event.commit && !servingForeground()) {
          running.controller.abort(new Error("Template prewarm superseded by a newer main head"));
        }
      }
      schedule();
    }
  });
  return {
    stop: () => {
      stopped = true;
      unsubscribe();
      active.clear();
      running?.controller.abort(new Error("Template prewarm stopped"));
    },
  };
}
