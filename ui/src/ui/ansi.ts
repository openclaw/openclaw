const ANSI_CSI_PATTERN = "\\x1b\\[[\\x20-\\x3f]*[\\x40-\\x7e]";
const OSC8_PATTERN = "\\x1b\\]8;;.*?\\x1b\\\\|\\x1b\\]8;;\\x1b\\\\";

const ANSI_CSI_REGEX = new RegExp(ANSI_CSI_PATTERN, "g");
const OSC8_REGEX = new RegExp(OSC8_PATTERN, "g");

export function stripAnsi(input: string): string {
  return input.replace(OSC8_REGEX, "").replace(ANSI_CSI_REGEX, "");
}
