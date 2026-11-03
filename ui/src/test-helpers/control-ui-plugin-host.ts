import { onTestFinished, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { createControlUiPluginHost } from "../plugins/control-ui-host.ts";
import {
  type ControlUiPluginOwner,
  ControlUiPluginRuntime,
} from "../plugins/control-ui-runtime.ts";
import { createTestGatewayClient } from "./gateway-client.ts";

/** Complete hosts for contribution fixtures, without activating plugins or making RPCs. */
export function createTestControlUiPluginHost(
  context: ApplicationContext,
  pluginId: string,
  abort = new AbortController(),
) {
  const runtime = new ControlUiPluginRuntime(() => context);
  const owner: Omit<ControlUiPluginOwner, "host"> = {
    descriptor: { pluginId, name: pluginId, revision: "1", entryUrl: "/fixture.js", styles: [] },
    client: context.gateway.snapshot.client ?? createTestGatewayClient(async () => ({})),
    abort,
    disposers: new Set(),
    contributions: {
      pages: new Map(),
      navigation: new Map(),
      panels: new Map(),
      actions: new Map(),
      accessories: new Map(),
      textReferences: new Map(),
      widgets: new Map(),
      inlineViews: new Map(),
      replacements: new Map(),
    },
    selections: new Map(),
  };
  // Contribution-only tests own a local activation instead of loading a Gateway catalog.
  vi.spyOn(runtime, "isCurrent").mockImplementation(
    (current) => current === owner && !owner.abort.signal.aborted,
  );
  onTestFinished(() => {
    owner.abort.abort();
    owner.disposers.forEach((dispose) => dispose());
    runtime.dispose();
  });
  return createControlUiPluginHost(() => context, runtime, owner);
}
