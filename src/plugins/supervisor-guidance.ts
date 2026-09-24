import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Display-only deployment guidance. Commands never confer execution authority. */
export type SupervisorAction =
  | "start"
  | "stop"
  | "restart"
  | "install"
  | "uninstall"
  | "repair"
  | "update";

export type SupervisorGuidanceV1 = {
  version: 1;
  name: string;
  runFrom?: string;
  actions: Partial<Record<SupervisorAction, string>>;
};

export type SupervisorDisplayGuidance = {
  version: 1;
  action: SupervisorAction;
  name: string;
  runFrom?: string;
  command: string;
};

export type PluginManifestSupervisorGuidance = {
  version: 1;
  /** Immediate own property of plugins.entries.<id>.config, not a dotted path. */
  configKey: string;
};

const ACTIONS: readonly SupervisorAction[] = [
  "start",
  "stop",
  "restart",
  "install",
  "uninstall",
  "repair",
  "update",
];
const textEncoder = new TextEncoder();
const FORBIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

function isText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    textEncoder.encode(value).byteLength <= maxLength &&
    value.trim() === value &&
    !FORBIDDEN_TEXT.test(value)
  );
}

export function parseManifestSupervisorGuidance(
  value: unknown,
): PluginManifestSupervisorGuidance | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isText(value.configKey, 128) ||
    Object.keys(value).some((key) => key !== "version" && key !== "configKey") ||
    ["__proto__", "constructor", "prototype"].includes(value.configKey)
  ) {
    return undefined;
  }
  return { version: 1, configKey: value.configKey };
}

/** Reject the complete descriptor on malformed copy; never rewrite command bytes. */
export function parseSupervisorGuidance(value: unknown): SupervisorGuidanceV1 | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isText(value.name, 128) ||
    (value.runFrom !== undefined && !isText(value.runFrom, 256)) ||
    Object.keys(value).some((key) => !["version", "name", "runFrom", "actions"].includes(key)) ||
    !isRecord(value.actions)
  ) {
    return undefined;
  }
  const keys = Object.keys(value.actions);
  if (keys.length === 0 || keys.some((key) => !ACTIONS.some((action) => action === key))) {
    return undefined;
  }
  const actions: SupervisorGuidanceV1["actions"] = {};
  for (const action of ACTIONS) {
    if (!Object.hasOwn(value.actions, action)) {
      continue;
    }
    const command = value.actions[action];
    if (!isText(command, 1024)) {
      return undefined;
    }
    actions[action] = command;
  }
  const guidance: SupervisorGuidanceV1 = {
    version: 1,
    name: value.name,
    ...(typeof value.runFrom === "string" ? { runFrom: value.runFrom } : {}),
    actions,
  };
  return textEncoder.encode(JSON.stringify(guidance)).byteLength <= 8192 ? guidance : undefined;
}
