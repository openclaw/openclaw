// 会话 ID 的正则表达式格式：8-4-4-4-12 的十六进制字符串
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 检查值是否看起来像会话 ID
// value: 要检查的字符串
export function looksLikeSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value.trim());
}
