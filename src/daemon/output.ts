import { colorize, isRich, theme } from "../terminal/theme.js";

export const toPosixPath = (value: string) => value.replace(/\\/g, "/");

export function formatLine(label: string, value: string): string {
  const rich = isRich();
  return `${colorize(rich, theme.muted, `${label}:`)} ${colorize(rich, theme.command, value)}`;
}
