import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../../config/bundled-channel-config-metadata.generated.js";
import type { LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";
import type { ConfigValidationIssue } from "../../../config/types.openclaw.js";
import { parseToolsBySenderTypedKey } from "../../../config/types.tools.js";
import { visitAgentConfigScopes } from "./legacy-config-record-shared.js";

const migrationMessage =
  'Untyped toolsBySender keys are retired. Run "openclaw doctor --fix" to migrate them to id: entries.';

type SenderPolicyScope = { parent: Record<string, unknown>; path: string };
type LegacySenderMap = SenderPolicyScope & { policies: Record<string, unknown>; keys: string[] };

const channelSchemas = new Map(
  GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map(({ channelId, schema }) => [channelId, schema]),
);

function* channelPolicyScopes(
  value: unknown,
  schema: unknown,
  path: string,
): Generator<SenderPolicyScope> {
  const parent = asNullableRecord(value);
  const node = asNullableRecord(schema);
  if (!parent || !node) {
    return;
  }
  const properties = asNullableRecord(node.properties);
  if (asNullableRecord(properties?.toolsBySender)) {
    yield { parent, path };
  }
  for (const [key, child] of Object.entries(parent)) {
    if (key !== "toolsBySender") {
      yield* channelPolicyScopes(
        child,
        properties?.[key] ?? node.additionalProperties,
        `${path}.${key}`,
      );
    }
  }
  for (const union of [node.anyOf, node.oneOf, node.allOf]) {
    for (const variant of Array.isArray(union) ? union : []) {
      yield* channelPolicyScopes(parent, variant, path);
    }
  }
}

function* legacySenderMaps(value: unknown): Generator<LegacySenderMap> {
  const raw = asNullableRecord(value);
  if (!raw) {
    return;
  }
  const scopes: Array<{ parent: unknown; path: string }> = [{ parent: raw.tools, path: "tools" }];
  visitAgentConfigScopes(raw, (entry, path) => {
    scopes.push({ parent: entry.tools, path: `${path}.tools` });
  });
  // Channel schemas declare policy locations; opaque plugin/model data is not a core policy.
  for (const [channelId, config] of Object.entries(asNullableRecord(raw.channels) ?? {})) {
    for (const scope of channelPolicyScopes(
      config,
      channelSchemas.get(channelId),
      `channels.${channelId}`,
    )) {
      scopes.push(scope);
    }
  }
  const seen = new Set<object>();
  for (const scope of scopes) {
    const parent = asNullableRecord(scope.parent);
    const policies = asNullableRecord(parent?.toolsBySender);
    if (!parent || !policies || seen.has(parent)) {
      continue;
    }
    seen.add(parent);
    const keys = Object.keys(policies).filter(
      (key) => key.trim() !== "*" && !parseToolsBySenderTypedKey(key),
    );
    if (keys.length > 0) {
      yield { parent, policies, path: `${scope.path}.toolsBySender`, keys };
    }
  }
}

export function collectLegacyToolsBySenderIssues(raw: unknown): ConfigValidationIssue[] {
  return Array.from(legacySenderMaps(raw)).flatMap(({ path, keys }) =>
    keys.map((key) => ({ path: `${path}.${key}`, message: migrationMessage })),
  );
}

export const LEGACY_CONFIG_MIGRATION_TOOLS_BY_SENDER: LegacyConfigMigrationSpec = {
  id: "toolsBySender.typed-keys",
  describe: "Migrate untyped sender tool policies before config validation",
  legacyRules: [
    { path: [], match: (raw) => !legacySenderMaps(raw).next().done, message: migrationMessage },
  ],
  apply(raw, changes) {
    for (const { parent, policies, path, keys } of legacySenderMaps(raw)) {
      const migrated = new Map<string, [string, unknown]>();
      let collisions = 0;
      let emptyKeys = 0;
      for (const [rawKey, policy] of Object.entries(policies)) {
        const trimmed = rawKey.trim();
        const typed = parseToolsBySenderTypedKey(trimmed);
        const senderId = (typed?.type === "id" ? typed.value : trimmed.replace(/^@/, "")).trim();
        if (!typed && !senderId) {
          emptyKeys++;
          continue;
        }
        const identity =
          typed?.type === "id" || (!typed && trimmed !== "*")
            ? `id:${senderId.toLowerCase()}`
            : rawKey;
        const key = !typed && trimmed !== "*" ? `id:${senderId}` : rawKey;
        // Runtime previously kept the first normalized ID, regardless of prefix.
        if (migrated.has(identity)) {
          collisions++;
        } else {
          migrated.set(identity, [key, policy]);
        }
      }
      parent.toolsBySender = Object.fromEntries(migrated.values());
      changes.push(
        `${path}: migrated ${keys.length - emptyKeys} untyped sender key(s) to id: entries.` +
          (collisions > 0
            ? ` Kept the first matching policy for ${collisions} shadowed key(s); original entries remain in the config backup.`
            : ""),
      );
      if (emptyKeys > 0) {
        changes.push(
          `${path}: removed ${emptyKeys} empty untyped sender key(s) that matched no sender; original entries remain in the config backup.`,
        );
      }
    }
  },
};
