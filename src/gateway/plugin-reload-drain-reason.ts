/** Retained work on one plugin being replaced, and whether a reload hands its turns over. */
export type PluginReloadDrainHold = {
  pluginId: string;
  count: number;
  turnHandover: boolean;
};

/**
 * Explains what a plugin reload's drain is waiting for. Work on plugins that hand turns
 * over is waiting for turns to reach their next step; work on other plugins is waiting
 * for whole turns, so those plugins are named.
 */
export function formatPluginReloadDrainReason(params: {
  holds: readonly PluginReloadDrainHold[];
  includeCalls: boolean;
  drainBudgetSeconds: number;
  cancellable: boolean;
}): string {
  const { holds, includeCalls, drainBudgetSeconds, cancellable } = params;
  const total = holds.reduce((sum, hold) => sum + hold.count, 0);
  const pinning = holds.filter((hold) => hold.count > 0 && !hold.turnHandover);
  const handingOver = holds.filter((hold) => hold.count > 0 && hold.turnHandover);
  const pluginIds = holds.map((hold) => hold.pluginId).join(", ");
  const parts = [
    `Plugin replacement queued behind ${total} ${includeCalls ? "admitted" : "retained"} work item(s) for plugin ${pluginIds}.`,
  ];
  if (handingOver.length) {
    parts.push(
      `Running turns on ${handingOver.map((hold) => hold.pluginId).join(", ")} continue on the new version at their next step.`,
    );
  }
  if (pinning.length) {
    parts.push(
      `Running turns keep ${pinning.map((hold) => hold.pluginId).join(", ")} until they finish because ${pinning.length === 1 ? "it does" : "they do"} not hand turns over (reload.turnHandover is not declared, or a context engine is registered).`,
    );
  }
  parts.push(`New agent runs wait up to the ${drainBudgetSeconds}s drain budget.`);
  if (cancellable) {
    parts.push("Press Ctrl+C to cancel the waiting reload.");
  }
  return parts.join(" ");
}
