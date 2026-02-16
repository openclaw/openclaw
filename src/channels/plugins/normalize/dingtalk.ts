export function normalizeDingTalkTarget(raw: string): string {
  let normalized = raw.replace(/^(dingtalk|dingtalk-connector|dd|ding):/i, "").trim();
  normalized = normalized.replace(/^(user|group):/i, "").trim();
  return normalized;
}
