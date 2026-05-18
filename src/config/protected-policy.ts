import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../utils.js";

export const CHANNEL_CONFIG_META_KEYS = new Set(["defaults", "modelByChannel"]);

export function isChannelConfigMetaKey(key: string): boolean {
  return CHANNEL_CONFIG_META_KEYS.has(key);
}

export function startsWithConfigPath(
  path: readonly string[],
  prefix: readonly string[],
): boolean {
  return prefix.every((segment, index) => path[index] === segment);
}

export function isSameConfigPath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

export function isExplicitConfigWritePathAncestorOrSelf(
  changedPath: readonly string[],
  explicitSetPaths: readonly (readonly string[])[] | undefined,
): boolean {
  if (!explicitSetPaths || explicitSetPaths.length === 0) {
    return false;
  }
  return explicitSetPaths.some((explicitPath) => startsWithConfigPath(changedPath, explicitPath));
}

function formatProtectedConfigPath(pathSegments: readonly string[]): string {
  return pathSegments.length > 0 ? pathSegments.join(".") : "<root>";
}

function getObjectPathValue(value: unknown, pathSegments: readonly string[]): unknown {
  let current = value;
  for (const segment of pathSegments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || String(index) !== segment) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function isEmptyProtectedPolicyValue(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every(isEmptyProtectedPolicyValue);
}

function isEmptyProtectedPolicyContainerChange(params: {
  previousConfig: unknown;
  nextConfig: unknown;
  changedPath: readonly string[];
}): boolean {
  return (
    isEmptyProtectedPolicyValue(getObjectPathValue(params.previousConfig, params.changedPath)) &&
    isEmptyProtectedPolicyValue(getObjectPathValue(params.nextConfig, params.changedPath))
  );
}

function findChangedArrayPath(
  previousConfig: unknown,
  nextConfig: unknown,
  changedPath: readonly string[],
): string[] | null {
  for (let length = changedPath.length; length >= 0; length -= 1) {
    const candidatePath = changedPath.slice(0, length);
    if (
      Array.isArray(getObjectPathValue(previousConfig, candidatePath)) ||
      Array.isArray(getObjectPathValue(nextConfig, candidatePath))
    ) {
      return candidatePath;
    }
  }
  return null;
}

function isExplicitConfigWritePathForChange(params: {
  previousConfig: unknown;
  nextConfig: unknown;
  changedPath: readonly string[];
  explicitSetPaths: readonly (readonly string[])[] | undefined;
}): boolean {
  if (isExplicitConfigWritePathAncestorOrSelf(params.changedPath, params.explicitSetPaths)) {
    return true;
  }
  if (!params.explicitSetPaths || params.explicitSetPaths.length === 0) {
    return false;
  }
  const arrayPath = findChangedArrayPath(
    params.previousConfig,
    params.nextConfig,
    params.changedPath,
  );
  if (!arrayPath) {
    return false;
  }
  return params.explicitSetPaths.some((explicitPath) =>
    startsWithConfigPath(explicitPath, arrayPath),
  );
}

function collectChangedConfigPaths(
  previousValue: unknown,
  nextValue: unknown,
  path: readonly string[],
  output: string[][],
): void {
  if (isDeepStrictEqual(previousValue, nextValue)) {
    return;
  }
  const previousArray = Array.isArray(previousValue);
  const nextArray = Array.isArray(nextValue);
  if (previousArray || nextArray) {
    if (
      (previousArray || previousValue === undefined) &&
      (nextArray || nextValue === undefined)
    ) {
      const previousList = previousArray ? previousValue : [];
      const nextList = nextArray ? nextValue : [];
      const max = Math.max(previousList.length, nextList.length);
      if (max === 0) {
        output.push([...path]);
        return;
      }
      for (let index = 0; index < max; index += 1) {
        collectChangedConfigPaths(
          previousList[index],
          nextList[index],
          [...path, String(index)],
          output,
        );
      }
      return;
    }
    output.push([...path]);
    return;
  }
  const previousRecord = isRecord(previousValue);
  const nextRecord = isRecord(nextValue);
  if (previousRecord || nextRecord) {
    const keys = new Set([
      ...(previousRecord ? Object.keys(previousValue) : []),
      ...(nextRecord ? Object.keys(nextValue) : []),
    ]);
    if (keys.size === 0) {
      output.push([...path]);
      return;
    }
    for (const key of keys) {
      collectChangedConfigPaths(
        previousRecord ? previousValue[key] : undefined,
        nextRecord ? nextValue[key] : undefined,
        [...path, key],
        output,
      );
    }
    return;
  }
  output.push([...path]);
}

function addProtectedReason(reasons: Set<string>, prefix: string, path: readonly string[]): void {
  reasons.add(`${prefix}:${formatProtectedConfigPath(path)}`);
}

function appendProtectedRootChangeReasons(params: {
  previousConfig: unknown;
  nextConfig: unknown;
  rootPath: readonly string[];
  reasonPrefix: string;
  explicitSetPaths?: readonly (readonly string[])[];
  reasons: Set<string>;
}): void {
  const changedPaths: string[][] = [];
  collectChangedConfigPaths(
    getObjectPathValue(params.previousConfig, params.rootPath),
    getObjectPathValue(params.nextConfig, params.rootPath),
    [...params.rootPath],
    changedPaths,
  );
  for (const changedPath of changedPaths) {
    if (
      isEmptyProtectedPolicyContainerChange({
        previousConfig: params.previousConfig,
        nextConfig: params.nextConfig,
        changedPath,
      })
    ) {
      continue;
    }
    if (
      isExplicitConfigWritePathForChange({
        previousConfig: params.previousConfig,
        nextConfig: params.nextConfig,
        changedPath,
        explicitSetPaths: params.explicitSetPaths,
      })
    ) {
      continue;
    }
    addProtectedReason(params.reasons, params.reasonPrefix, params.rootPath);
  }
}

function listAgentRelativeExplicitSetPaths(params: {
  explicitSetPaths?: readonly (readonly string[])[];
  agentId: string | null;
  index: number;
}): readonly (readonly string[])[] | undefined {
  const relativePaths = params.explicitSetPaths?.flatMap((explicitPath) => {
    if (explicitPath[0] !== "agents") {
      return [];
    }
    if (explicitPath.length === 1) {
      return [[]];
    }
    if (explicitPath[1] !== "list") {
      return [];
    }
    if (explicitPath.length === 2) {
      return [[]];
    }
    const selector = explicitPath[2];
    if (selector !== String(params.index) && (!params.agentId || selector !== params.agentId)) {
      return [];
    }
    const relativePath = explicitPath.slice(3);
    return [relativePath];
  });
  return relativePaths && relativePaths.length > 0 ? relativePaths : undefined;
}

function appendAgentElevatedToolsChangeReasons(params: {
  previousAgent: unknown;
  nextAgent: unknown;
  agentId: string | null;
  index: number;
  explicitSetPaths?: readonly (readonly string[])[];
  reasons: Set<string>;
}): void {
  const rootPath = ["tools", "elevated", "allowFrom"];
  const displayRootPath = [
    "agents",
    "list",
    params.agentId ?? String(params.index),
    "tools",
    "elevated",
    "allowFrom",
  ];
  const changedPaths: string[][] = [];
  collectChangedConfigPaths(
    getObjectPathValue(params.previousAgent, rootPath),
    getObjectPathValue(params.nextAgent, rootPath),
    rootPath,
    changedPaths,
  );
  const relativeExplicitSetPaths = listAgentRelativeExplicitSetPaths({
    explicitSetPaths: params.explicitSetPaths,
    agentId: params.agentId,
    index: params.index,
  });
  for (const changedPath of changedPaths) {
    if (
      isEmptyProtectedPolicyContainerChange({
        previousConfig: params.previousAgent,
        nextConfig: params.nextAgent,
        changedPath,
      })
    ) {
      continue;
    }
    if (
      isExplicitConfigWritePathForChange({
        previousConfig: params.previousAgent,
        nextConfig: params.nextAgent,
        changedPath,
        explicitSetPaths: relativeExplicitSetPaths,
      })
    ) {
      continue;
    }
    addProtectedReason(
      params.reasons,
      "protected-agent-elevated-tools-changed",
      displayRootPath,
    );
  }
}

function appendAgentProtectedPolicyChangeReasons(params: {
  previousConfig: unknown;
  nextConfig: unknown;
  explicitSetPaths?: readonly (readonly string[])[];
  reasons: Set<string>;
}): void {
  const previousAgents = getObjectPathValue(params.previousConfig, ["agents", "list"]);
  const nextAgents = getObjectPathValue(params.nextConfig, ["agents", "list"]);
  const previousAgentsById = new Map<string, { agent: unknown; index: number }>();
  if (Array.isArray(previousAgents)) {
    previousAgents.forEach((agent, index) => {
      const id = isRecord(agent) && typeof agent.id === "string" ? agent.id : null;
      if (id) {
        previousAgentsById.set(id, { agent, index });
      }
    });
  }
  const nextAgentsById = new Map<string, { agent: unknown; index: number }>();
  if (Array.isArray(nextAgents)) {
    nextAgents.forEach((agent, index) => {
      const id = isRecord(agent) && typeof agent.id === "string" ? agent.id : null;
      if (id) {
        nextAgentsById.set(id, { agent, index });
      }
    });
  }
  const handledNextIndexes = new Set<number>();
  if (Array.isArray(previousAgents)) {
    previousAgents.forEach((previousAgent, index) => {
      if (!isRecord(previousAgent)) {
        return;
      }
      const id = typeof previousAgent.id === "string" ? previousAgent.id : null;
      const nextEntry = id
        ? nextAgentsById.get(id)
        : Array.isArray(nextAgents)
          ? { agent: nextAgents[index], index }
          : undefined;
      if (nextEntry) {
        handledNextIndexes.add(nextEntry.index);
      }
      appendAgentElevatedToolsChangeReasons({
        previousAgent,
        nextAgent: nextEntry?.agent,
        agentId: id,
        index,
        explicitSetPaths: params.explicitSetPaths,
        reasons: params.reasons,
      });
    });
  }
  if (!Array.isArray(nextAgents)) {
    return;
  }
  nextAgents.forEach((nextAgent, index) => {
    if (!isRecord(nextAgent) || handledNextIndexes.has(index)) {
      return;
    }
    const id = typeof nextAgent.id === "string" ? nextAgent.id : null;
    if (id && previousAgentsById.has(id)) {
      return;
    }
    appendAgentElevatedToolsChangeReasons({
      previousAgent: undefined,
      nextAgent,
      agentId: id,
      index,
      explicitSetPaths: params.explicitSetPaths,
      reasons: params.reasons,
    });
  });
}

function resolveChannelProtectedRoot(path: readonly string[]): string[] | null {
  if (path[0] !== "channels") {
    return null;
  }
  const channelId = path[1];
  if (!channelId || isChannelConfigMetaKey(channelId)) {
    return null;
  }
  if (path[2] === "accounts" && path[3]) {
    return ["channels", channelId, "accounts", path[3]];
  }
  return ["channels", channelId];
}

function appendChannelProtectedPolicyChangeReasons(params: {
  previousConfig: unknown;
  nextConfig: unknown;
  explicitSetPaths?: readonly (readonly string[])[];
  reasons: Set<string>;
}): void {
  const previousChannels = getObjectPathValue(params.previousConfig, ["channels"]);
  const nextChannels = getObjectPathValue(params.nextConfig, ["channels"]);
  const channelIds = new Set([
    ...(isRecord(previousChannels) ? Object.keys(previousChannels) : []),
    ...(isRecord(nextChannels) ? Object.keys(nextChannels) : []),
  ]);
  for (const channelId of channelIds) {
    if (isChannelConfigMetaKey(channelId)) {
      continue;
    }
    const channelPath = ["channels", channelId];
    const changedPaths: string[][] = [];
    collectChangedConfigPaths(
      isRecord(previousChannels) ? previousChannels[channelId] : undefined,
      isRecord(nextChannels) ? nextChannels[channelId] : undefined,
      channelPath,
      changedPaths,
    );
    for (const changedPath of changedPaths) {
      if (
        isEmptyProtectedPolicyContainerChange({
          previousConfig: params.previousConfig,
          nextConfig: params.nextConfig,
          changedPath,
        })
      ) {
        continue;
      }
      if (
        isExplicitConfigWritePathForChange({
          previousConfig: params.previousConfig,
          nextConfig: params.nextConfig,
          changedPath,
          explicitSetPaths: params.explicitSetPaths,
        })
      ) {
        continue;
      }
      const protectedRoot = resolveChannelProtectedRoot(changedPath);
      if (protectedRoot) {
        addProtectedReason(params.reasons, "protected-channel-config-changed", protectedRoot);
      }
    }
  }
}

export function listProtectedConfigPolicyChangeReasons(params: {
  previousConfig: unknown;
  nextConfig: unknown;
  explicitSetPaths?: readonly (readonly string[])[];
}): string[] {
  const reasons = new Set<string>();
  appendProtectedRootChangeReasons({
    previousConfig: params.previousConfig,
    nextConfig: params.nextConfig,
    rootPath: ["commands", "ownerAllowFrom"],
    reasonPrefix: "protected-command-policy-changed",
    explicitSetPaths: params.explicitSetPaths,
    reasons,
  });
  appendProtectedRootChangeReasons({
    previousConfig: params.previousConfig,
    nextConfig: params.nextConfig,
    rootPath: ["commands", "allowFrom"],
    reasonPrefix: "protected-command-policy-changed",
    explicitSetPaths: params.explicitSetPaths,
    reasons,
  });
  appendProtectedRootChangeReasons({
    previousConfig: params.previousConfig,
    nextConfig: params.nextConfig,
    rootPath: ["tools", "elevated", "allowFrom"],
    reasonPrefix: "protected-elevated-tools-changed",
    explicitSetPaths: params.explicitSetPaths,
    reasons,
  });
  appendAgentProtectedPolicyChangeReasons({
    previousConfig: params.previousConfig,
    nextConfig: params.nextConfig,
    explicitSetPaths: params.explicitSetPaths,
    reasons,
  });
  appendChannelProtectedPolicyChangeReasons({
    previousConfig: params.previousConfig,
    nextConfig: params.nextConfig,
    explicitSetPaths: params.explicitSetPaths,
    reasons,
  });
  return [...reasons];
}

export function resolveProtectedConfigPolicyWriteBlockingReasons(params: {
  previousConfig: unknown;
  nextConfig: unknown;
  explicitSetPaths?: readonly (readonly string[])[];
  allowProtectedConfigPolicyDrop?: boolean;
}): string[] {
  const reasons = listProtectedConfigPolicyChangeReasons({
    previousConfig: params.previousConfig,
    nextConfig: params.nextConfig,
    explicitSetPaths: params.explicitSetPaths,
  });
  if (params.allowProtectedConfigPolicyDrop === true) {
    return [];
  }
  return reasons;
}

export function resolveProtectedConfigPolicyPath(
  changedPath: readonly string[],
): string[] | null {
  if (changedPath[0] === "commands") {
    if (changedPath.length === 1) {
      return ["commands"];
    }
    const key = changedPath[1];
    return key === "ownerAllowFrom" || key === "allowFrom" ? ["commands", key] : null;
  }
  if (changedPath[0] === "tools") {
    if (
      changedPath.length === 1 ||
      (changedPath[1] === "elevated" &&
        (changedPath.length === 2 || changedPath[2] === "allowFrom"))
    ) {
      return ["tools", "elevated", "allowFrom"];
    }
    return null;
  }
  if (changedPath[0] === "agents") {
    if (changedPath.length === 1 || changedPath.length === 2) {
      return ["agents", "list"];
    }
    if (
      changedPath[1] === "list" &&
      changedPath[2] &&
      changedPath[3] === "tools" &&
      changedPath[4] === "elevated" &&
      (changedPath.length === 5 || changedPath[5] === "allowFrom")
    ) {
      return ["agents", "list", changedPath[2], "tools", "elevated", "allowFrom"];
    }
    return null;
  }
  if (changedPath[0] === "channels") {
    const channelId = changedPath[1];
    if (!channelId) {
      return ["channels"];
    }
    if (isChannelConfigMetaKey(channelId)) {
      return null;
    }
    return ["channels", channelId];
  }
  return null;
}
