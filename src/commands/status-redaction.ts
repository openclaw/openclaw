export function redactStatusSecrets(text: string): string {
  if (!text) {
    return text;
  }
  let out = text;
  out = out.replace(
    /(["']?\b(?:access[_-]?token|refresh[_-]?token|token|password|secret|api[_-]?key)\b["']?\s*[:=]\s*)(?:Bearer\s+[^\s]+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gi,
    "$1***",
  );
  out = out.replace(/\bBearer\s+[^\s]+/gi, "Bearer ***");
  out = out.replace(/\bsk-[A-Za-z0-9]{10,}\b/g, "sk-***");
  return out;
}
