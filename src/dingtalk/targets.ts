export type DingTalkTarget = { type: "user" | "group"; id: string };

export function normalizeDingTalkTarget(raw: string): string {
  let normalized = raw.replace(/^(dingtalk|dingtalk-connector|dd|ding):/i, "").trim();
  normalized = normalized.replace(/^(user|group):/i, "").trim();
  return normalized;
}

export function resolveDingTalkTargetType(target: string): "user" | "group" {
  const trimmed = target.trim();
  if (trimmed.startsWith("user:")) {
    return "user";
  }
  if (trimmed.startsWith("group:")) {
    return "group";
  }
  if (trimmed.includes("=") || trimmed.length > 30) {
    return "group";
  }
  return "user";
}

export function parseDingTalkTarget(target: string): DingTalkTarget {
  const trimmed = target.trim();
  if (trimmed.startsWith("user:")) {
    return { type: "user", id: trimmed.slice("user:".length) };
  }
  if (trimmed.startsWith("group:")) {
    return { type: "group", id: trimmed.slice("group:".length) };
  }
  const normalized = normalizeDingTalkTarget(trimmed);
  return { type: resolveDingTalkTargetType(trimmed), id: normalized };
}
