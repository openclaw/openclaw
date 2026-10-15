import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isInlineViewPayload } from "../plugins/inline-view.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import {
  readPluginInlineViewBlock,
  type PluginInlineViewBlock,
} from "../shared/plugin-inline-view.js";

type Invocation = { toolCallId?: unknown; toolName?: unknown };
type ViewRegistration = PluginRegistry["controlUiDescriptors"][number];
const snapshots = new WeakMap<
  PluginRegistry,
  { plugins: Set<string>; views: Map<string, ViewRegistration> }
>();

function snapshot(registry: PluginRegistry) {
  let value = snapshots.get(registry);
  if (!value) {
    value = {
      plugins: new Set(
        registry.plugins
          .filter((plugin) => plugin.enabled && plugin.status === "loaded")
          .map((plugin) => plugin.id),
      ),
      views: new Map(
        registry.controlUiDescriptors
          .filter((entry) => entry.descriptor.surface === "inline")
          .map((entry) => [JSON.stringify([entry.pluginId, entry.descriptor.id]), entry]),
      ),
    };
    snapshots.set(registry, value);
  }
  return value;
}

/** Current installed metadata decides display compatibility; stored tool results stay unchanged. */
export function projectPluginInlineView(
  details: unknown,
  invocation: Invocation,
  registry?: PluginRegistry,
): PluginInlineViewBlock | undefined {
  const record = asOptionalRecord(details);
  const descriptor = asOptionalRecord(record?.pluginInlineView);
  const owner = asOptionalRecord(record?.pluginInlineViewInvocation);
  const projected = readPluginInlineViewBlock(record?.pluginView);
  const source =
    descriptor &&
    owner &&
    owner.pluginId === descriptor.pluginId &&
    typeof descriptor.pluginId === "string" &&
    typeof descriptor.viewId === "string" &&
    typeof owner.toolCallId === "string" &&
    typeof owner.toolName === "string" &&
    typeof owner.summary === "string" &&
    owner.summary.trim()
      ? {
          pluginId: descriptor.pluginId,
          viewId: descriptor.viewId,
          toolCallId: owner.toolCallId,
          toolName: owner.toolName,
          summary: owner.summary,
          payload: descriptor.payload,
        }
      : projected;
  if (
    !source ||
    source.toolCallId !== invocation.toolCallId ||
    source.toolName !== invocation.toolName
  ) {
    return undefined;
  }
  const ownerRegistry = registry ?? getPluginRegistryForContext();
  const current = ownerRegistry ? snapshot(ownerRegistry) : undefined;
  const view = current?.views.get(JSON.stringify([source.pluginId, source.viewId]));
  const payload = source.payload;
  const payloadValid = isInlineViewPayload(payload);
  const status = !current?.plugins.has(source.pluginId)
    ? "plugin-missing"
    : !view
      ? "view-missing"
      : !payloadValid || !view.validateInlinePayload?.(source.payload)
        ? "invalid-payload"
        : "ok";
  return {
    type: "plugin_view",
    pluginId: source.pluginId,
    viewId: source.viewId,
    toolCallId: source.toolCallId,
    toolName: source.toolName,
    summary: source.summary,
    ...(view ? { label: view.descriptor.label } : {}),
    status,
    ...(status === "ok" && payloadValid ? { payload } : {}),
  };
}
