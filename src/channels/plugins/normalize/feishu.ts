export function normalizeFeishuTarget(raw: string): string {
  let normalized = raw.replace(/^(feishu|lark):/i, "").trim();
  normalized = normalized.replace(/^(group|chat|user|dm):/i, "").trim();
  return normalized;
}
