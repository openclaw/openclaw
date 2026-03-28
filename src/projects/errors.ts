export interface FrontmatterParseWarning {
  filePath: string;
  message: string;
  issues: Array<{ path: string; message: string; line?: number }>;
}

export function formatWarning(warning: FrontmatterParseWarning): string {
  const lines = warning.issues.map((i) => {
    const loc = i.line ? `:${i.line}` : "";
    const path = i.path ? ` (${i.path})` : "";
    return `  - ${i.message}${path} at ${warning.filePath}${loc}`;
  });
  return `${warning.message}\n${lines.join("\n")}`;
}
