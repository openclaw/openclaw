import { theme } from "../terminal/theme.js";
export function formatHelpExample(command, description) {
    return `  ${theme.command(command)}\n    ${theme.muted(description)}`;
}
export function formatHelpExampleLine(command, description) {
    if (!description) {
        return `  ${theme.command(command)}`;
    }
    return `  ${theme.command(command)} ${theme.muted(`# ${description}`)}`;
}
export function formatHelpExamples(examples, inline = false) {
    const formatter = inline ? formatHelpExampleLine : formatHelpExample;
    return examples.map(([command, description]) => formatter(command, description)).join("\n");
}
export function formatHelpExampleGroup(label, examples, inline = false) {
    return `${theme.muted(label)}\n${formatHelpExamples(examples, inline)}`;
}
