import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import {
  bindAgentToolAvailability,
  getAgentToolAvailabilityBinding,
  isAgentToolExecutionAvailable,
  type AgentToolAvailabilityBinding,
} from "../../agent-tool-availability.js";
import { SESSIONS_SPAWN_COLLECTOR_GUIDANCE } from "../../tool-description-presets.js";
import { filterRuntimeCompatibleTools } from "../../tool-schema-projection.js";
import { ToolInputError, type AnyAgentTool } from "../../tools/common.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";

const COLLECTOR_FIELDS = ["collect", "outputSchema", "groupId"] as const;
const WAIT_GUIDANCE = SESSIONS_SPAWN_COLLECTOR_GUIDANCE.replace(
  /\.$/u,
  "; await with agents_wait.",
);
const readerBinding: AgentToolAvailabilityBinding = { prepare() {} };
type SpawnCapability = {
  nativeReader: Pick<AnyAgentTool, "name" | "parameters"> | undefined;
  signal?: AbortSignal;
};
const spawnCapabilities = new WeakMap<AgentToolAvailabilityBinding, SpawnCapability>();
const collectorFieldsBySchema = new WeakMap<object, Record<string, unknown>>();
const collectorSchemaVariants = new WeakMap<
  object,
  { fields: Record<string, unknown>; schema: AnyAgentTool["parameters"] }
>();
type JoinedSpawn = {
  owner: AgentToolAvailabilityBinding;
  assertCurrent: () => void;
  active: boolean;
  toolCallId?: string;
  claimed: boolean;
  nativePluginOwner?: SubagentRunRecord["nativePluginOwner"];
  subagentProfile?: import("../../../plugins/subagent-profile.types.js").RegisteredSubagentProfile;
};
const joinedSpawns = new AsyncLocalStorage<JoinedSpawn>();

export function markCollectorReaderTool<T extends AnyAgentTool>(tool: T): T {
  return bindAgentToolAvailability(tool, readerBinding);
}

function isNativeCollectorReader(
  tool: Pick<AnyAgentTool, "name" | "parameters"> | undefined,
): boolean {
  return (
    tool !== undefined &&
    getAgentToolAvailabilityBinding(tool) === readerBinding &&
    filterRuntimeCompatibleTools([tool]).tools.length === 1
  );
}

/** A schema-only, gated or shadowed agents_wait cannot authorize native collector work. */
export function isCallableCollectorReader(
  tool: Pick<AnyAgentTool, "name" | "parameters"> | undefined,
): boolean {
  return tool !== undefined && isAgentToolExecutionAvailable(tool) && isNativeCollectorReader(tool);
}

function collectorSchema(
  schema: unknown,
  fields: Record<string, unknown>,
): AnyAgentTool["parameters"] {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    throw new ToolInputError("Collector spawn schema is unavailable.");
  }
  const previousProperties = schema.properties;
  if (COLLECTOR_FIELDS.every((field) => previousProperties[field] === fields[field])) {
    return schema;
  }
  const cached = collectorSchemaVariants.get(schema);
  if (cached && COLLECTOR_FIELDS.every((field) => cached.fields[field] === fields[field])) {
    return cached.schema;
  }
  const properties = { ...previousProperties };
  for (const field of COLLECTOR_FIELDS) {
    delete properties[field];
  }
  const variant = { ...schema, properties: { ...properties, ...fields } };
  // Mutable custom schemas retain their existing projection behavior.
  if (Object.isFrozen(schema)) {
    Object.freeze(variant.properties);
    Object.freeze(variant);
    collectorSchemaVariants.set(schema, { fields: { ...fields }, schema: variant });
  }
  return variant;
}

function selectCollectorFields(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    COLLECTOR_FIELDS.filter((field) => field in properties).map((field) => [
      field,
      properties[field],
    ]),
  );
}

function collectorFieldsFromSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return undefined;
  }
  const fields = selectCollectorFields(schema.properties);
  return Object.keys(fields).length > 0 ? fields : undefined;
}

export function bindCollectorSpawnTool<T extends AnyAgentTool>(
  tool: T,
  properties: Record<string, unknown>,
  signal?: AbortSignal,
): T {
  const fields = selectCollectorFields(properties);
  const capability: SpawnCapability = { nativeReader: undefined, signal };
  const binding: AgentToolAvailabilityBinding = {
    prepare(current, callableTools, offeredTools) {
      const schema = current.parameters;
      const retainedFields = collectorFieldsBySchema.get(schema);
      const currentFields = retainedFields ?? collectorFieldsFromSchema(schema) ?? fields;
      const nativeReader = (reader: ReturnType<typeof callableTools.get>) =>
        reader && isNativeCollectorReader(reader) ? reader : undefined;
      // An offered reader keeps the collector definition stable across turns; only a
      // callable reader lets this turn start a collector (see the spawn guard).
      const offeredReader = nativeReader(offeredTools.get("agents_wait"));
      const callableReader = callableTools.get("agents_wait");
      capability.nativeReader = isCallableCollectorReader(callableReader)
        ? callableReader
        : undefined;
      const preparedSchema = collectorSchema(schema, offeredReader ? currentFields : {});
      // Hook wrappers share schemas, not tool objects, while collector fields are hidden.
      if (preparedSchema !== schema || !retainedFields) {
        collectorFieldsBySchema.set(preparedSchema, currentFields);
      }
      current.parameters = preparedSchema;
      const description = current.description
        .replace(WAIT_GUIDANCE, "")
        .replace(SESSIONS_SPAWN_COLLECTOR_GUIDANCE, "")
        .trim();
      current.description =
        offeredReader && Object.keys(fields).length > 0
          ? `${description} ${WAIT_GUIDANCE}`
          : description;
    },
    executionSchema(currentSchema) {
      const joined = joinedSpawns.getStore();
      if (joined?.owner !== binding) {
        return currentSchema;
      }
      assertJoinedSpawn(joined);
      return collectorSchema(currentSchema, fields);
    },
  };
  spawnCapabilities.set(binding, capability);
  bindAgentToolAvailability(tool, binding);
  binding.prepare(tool, new Map(), new Map());
  return tool;
}

export function isCollectorSpawnTool(tool: object): tool is AnyAgentTool {
  const binding = getAgentToolAvailabilityBinding(tool);
  return binding !== undefined && spawnCapabilities.has(binding);
}

function assertJoinedSpawn(joined: JoinedSpawn): void {
  if (!joined.active) {
    throw new ToolInputError("Joined collector spawn is no longer active.");
  }
  joined.assertCurrent();
}

/** One lexical joined call; neither replay metadata nor guest input can mint it. */
export async function runWithJoinedCollectorSpawn<T>(
  tool: object,
  assertCurrent: () => void,
  run: () => Promise<T>,
  nativePluginOwner?: SubagentRunRecord["nativePluginOwner"],
  subagentProfile?: JoinedSpawn["subagentProfile"],
): Promise<T> {
  const owner = getAgentToolAvailabilityBinding(tool);
  if (!owner || !spawnCapabilities.has(owner)) {
    throw new ToolInputError("agents.run requires the native collector spawn tool.");
  }
  const joined: JoinedSpawn = {
    owner,
    assertCurrent,
    active: true,
    claimed: false,
    nativePluginOwner,
    subagentProfile,
  };
  return await joinedSpawns.run(joined, async () => {
    try {
      assertJoinedSpawn(joined);
      return await run();
    } finally {
      joined.active = false;
    }
  });
}

/** Only the exact claimed native spawn can carry SDK provenance into registration. */
function captureCollectorPluginOwner(tool: object, toolCallId: string) {
  const joined = joinedSpawns.getStore();
  if (
    !joined ||
    !joined.claimed ||
    joined.toolCallId !== toolCallId ||
    joined.owner !== getAgentToolAvailabilityBinding(tool)
  ) {
    return undefined;
  }
  assertJoinedSpawn(joined);
  return joined.nativePluginOwner ? { ...joined.nativePluginOwner } : undefined;
}

/** Capture host-only SDK context once at the exact claimed invocation. */
export function captureCollectorPluginContext(tool: object, toolCallId: string) {
  const nativePluginOwner = captureCollectorPluginOwner(tool, toolCallId);
  const profile = joinedSpawns.getStore()?.subagentProfile;
  return {
    nativePluginOwner,
    subagentProfile:
      nativePluginOwner && profile?.pluginId === nativePluginOwner.pluginId ? profile : undefined,
  };
}

/** Bind the private context to the catalog's exact invocation before awaited hooks. */
export function bindJoinedCollectorInvocation(tool: object, toolCallId: string): void {
  const joined = joinedSpawns.getStore();
  if (!joined || joined.owner !== getAgentToolAvailabilityBinding(tool)) {
    return;
  }
  assertJoinedSpawn(joined);
  if (joined.toolCallId !== undefined) {
    throw new ToolInputError("Joined collector spawn already has an invocation.");
  }
  joined.toolCallId = toolCallId;
}

export function captureCollectorSpawnGuard(
  tool: object,
  toolCallId: string,
  assertActive: () => void,
): () => void {
  const owner = getAgentToolAvailabilityBinding(tool);
  const capability = owner && spawnCapabilities.get(owner);
  const current = joinedSpawns.getStore();
  const joined =
    current && current.owner === owner && current.toolCallId === toolCallId ? current : undefined;
  if (joined) {
    assertJoinedSpawn(joined);
    if (joined.claimed) {
      throw new ToolInputError("Joined collector spawn was already claimed.");
    }
    joined.claimed = true;
  }
  return composeSessionSourceAssertion([assertActive], (assertSource) => {
    assertSource();
    capability?.signal?.throwIfAborted();
    if (joined) {
      assertJoinedSpawn(joined);
    }
    if (
      (!joined || joined.nativePluginOwner) &&
      !isCallableCollectorReader(capability?.nativeReader)
    ) {
      throw new ToolInputError(
        "Collector results are unavailable in this tool surface. Omit collect, outputSchema, and groupId to start an ordinary announcing child.",
      );
    }
  });
}
