/**
 * Schema labels spell out their full path so they read alone: "Browser Profile CDP Port". Under
 * a heading that already says "Browser profiles", the row only needs "CDP port".
 */
export function configLabelInContext(label: string, contextLabel: string | undefined): string {
  if (!contextLabel) {
    return label;
  }
  const context = contextLabel.toLowerCase();
  const prefixes = context.endsWith("s") ? [context, context.slice(0, -1)] : [context];
  const lower = label.toLowerCase();
  const prefix = prefixes.find((candidate) => lower.startsWith(`${candidate} `));
  if (!prefix) {
    return label;
  }
  const rest = label.slice(prefix.length + 1);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}
