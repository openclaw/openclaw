import { colorize, isRich, theme } from "../terminal/theme.js";
export const toPosixPath = (value) => value.replace(/\\/g, "/");
export function formatLine(label, value) {
    const rich = isRich();
    return `${colorize(rich, theme.muted, `${label}:`)} ${colorize(rich, theme.command, value)}`;
}
export function writeFormattedLines(stdout, lines, opts) {
    if (opts?.leadingBlankLine) {
        stdout.write("\n");
    }
    for (const line of lines) {
        stdout.write(`${formatLine(line.label, line.value)}\n`);
    }
}
