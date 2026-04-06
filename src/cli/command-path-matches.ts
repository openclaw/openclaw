export type CommandPathMatchRule =
  | readonly string[]
  | {
      pattern: readonly string[];
      exact?: boolean;
    };

export function matchesCommandPath(
  commandPath: string[],
  pattern: readonly string[],
  params?: { exact?: boolean },
): boolean {
  if (pattern.some((segment, index) => commandPath[index] !== segment)) {
    return false;
  }
  return !params?.exact || commandPath.length === pattern.length;
}

export function matchesCommandPathRule(commandPath: string[], rule: CommandPathMatchRule): boolean {
  if (Array.isArray(rule)) {
    return matchesCommandPath(commandPath, rule);
  }
  return matchesCommandPath(commandPath, rule.pattern, { exact: rule.exact });
}

export function matchesAnyCommandPath(
  commandPath: string[],
  rules: readonly CommandPathMatchRule[],
): boolean {
  return rules.some((rule) => matchesCommandPathRule(commandPath, rule));
}
