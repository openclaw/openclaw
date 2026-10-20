import type { CronCompactJob } from "../../api/types.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import {
  sessionAutomationInventory,
  type SessionAutomationPresentation,
  type SessionAutomationInventory,
} from "../cron/session-automation-inventory.ts";
import { createInitialCronState } from "../cron/state.ts";
import { projectSource } from "./projection.ts";

export type SessionAutomationInventorySource = SessionAutomationPresentation & {
  gateway: ApplicationGateway | undefined;
  sessionKey: string;
};

/** Read-through projection; all data, admission, and upstream lifetimes stay with the owner. */
export function projectSessionAutomationInventory() {
  let current: SessionAutomationInventory | undefined;
  const empty = { cron: createInitialCronState<CronCompactJob>(), readable: false, error: false };
  const inventory = (scope: SessionAutomationInventorySource | null) =>
    scope?.gateway ? sessionAutomationInventory(scope.gateway, scope.sessionKey) : undefined;
  const view = projectSource<SessionAutomationInventorySource | null, typeof empty>(null, {
    read: (scope) => {
      current = inventory(scope);
      return current?.read() ?? empty;
    },
    subscribe: (scope, notify) => {
      current = inventory(scope);
      return scope ? (current?.observe(notify, scope) ?? (() => {})) : () => {};
    },
    equality: "revision",
  });
  return {
    ...view,
    activate: () => current?.activate(),
    park: () => current?.park(),
    load: (options: { append?: boolean } = {}) => current?.load(options) ?? Promise.resolve(),
  };
}
