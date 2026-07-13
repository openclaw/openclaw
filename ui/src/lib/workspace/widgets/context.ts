import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { WorkspaceWidget } from "../types.ts";
import type { BuiltinWidgetContext } from "./types.ts";

type BuiltinContextProps = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  basePath?: string;
  embed?: BuiltinWidgetContext["embed"];
};

const DEFAULT_EMBED_CONTEXT: BuiltinWidgetContext["embed"] = {
  embedSandboxMode: "strict",
  allowExternalEmbedUrls: false,
};

const builtinStateByClient = new WeakMap<
  GatewayBrowserClient,
  Map<string, NonNullable<BuiltinWidgetContext["state"]>>
>();

function getBuiltinState(
  client: GatewayBrowserClient,
  widgetId: string,
): NonNullable<BuiltinWidgetContext["state"]> {
  let states = builtinStateByClient.get(client);
  if (!states) {
    states = new Map();
    builtinStateByClient.set(client, states);
  }
  const existing = states.get(widgetId);
  if (existing) {
    return existing;
  }
  const state: NonNullable<BuiltinWidgetContext["state"]> = {
    get: async () => {
      const payload = (await client.request("workspaces.widget.state.get", {
        widgetId,
      })) as { state?: unknown; version?: unknown } | null;
      if (
        typeof payload?.version !== "number" ||
        !Number.isInteger(payload.version) ||
        payload.version < 0
      ) {
        throw new Error("Invalid widget state response.");
      }
      return { state: payload.state ?? null, version: payload.version };
    },
    set: async (value, expectedVersion) => {
      const payload = (await client.request("workspaces.widget.state.set", {
        widgetId,
        state: value,
        expectedVersion,
      })) as { version?: unknown } | null;
      if (
        typeof payload?.version !== "number" ||
        !Number.isInteger(payload.version) ||
        payload.version < 1
      ) {
        throw new Error("Invalid widget state response.");
      }
      return { version: payload.version };
    },
  };
  states.set(widgetId, state);
  return state;
}

/** Bind trusted builtin persistence to the host-owned widget id. */
export function buildBuiltinContext(
  props: BuiltinContextProps,
  widget: WorkspaceWidget,
): BuiltinWidgetContext {
  const context: BuiltinWidgetContext = {
    basePath: props.basePath ?? "",
    embed: props.embed ?? DEFAULT_EMBED_CONTEXT,
  };
  if (!props.client || !props.connected) {
    return context;
  }
  return {
    ...context,
    state: getBuiltinState(props.client, widget.id),
  };
}
