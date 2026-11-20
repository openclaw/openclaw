import type { SessionBindingRecord } from "../infra/outbound/session-binding.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginConversationBindingCurrent } from "./conversation-binding-authority.types.js";

export type PluginConversationBindingCurrentSource = {
  databaseIdentity: string;
  record: SessionBindingRecord;
};
const restrictions = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginConversationBindingCurrent"),
  () =>
    new WeakMap<
      object,
      { source: PluginConversationBindingCurrentSource; assertCurrent(): void }
    >(),
);

/** Only the binding owner mints restrictions. A copied/serialized token never grants a scope. */
export function mintPluginConversationBindingCurrent(
  source: PluginConversationBindingCurrentSource,
  assertCurrent: () => void,
) {
  // SAFETY: The private registry, not this TypeScript brand, establishes provenance.
  const token = Object.freeze({}) as PluginConversationBindingCurrent;
  restrictions.set(token, { source, assertCurrent });
  return token;
}

export function capturePluginConversationBindingCurrent(
  token: PluginConversationBindingCurrent | undefined,
  pluginId: string,
) {
  if (token === undefined) {
    return undefined;
  }
  const restriction = restrictions.get(token);
  if (!restriction || restriction.source.record.metadata?.pluginId !== pluginId) {
    throw new Error("Plugin conversation binding authority is unavailable");
  }
  restriction.assertCurrent();
  return restriction;
}
