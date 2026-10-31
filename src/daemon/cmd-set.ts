type CmdSetAssignment = { key: string; value: string };

export const CMD_SET_LITERAL_PREAMBLE = "setlocal DisableDelayedExpansion";

export function assertNoCmdLineBreak(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${field} cannot contain CR or LF in Windows task scripts.`);
  }
}

function escapeLiteralCmdSetAssignment(value: string): string {
  let quoted = true;
  let escaped = "";
  for (const character of value) {
    if (character === '"') {
      quoted = !quoted;
      escaped += character;
    } else if (character === "%") {
      escaped += "%%";
    } else {
      // SET keeps embedded quotes; CMD only consumes carets outside those quotes.
      escaped += !quoted && /[&|<>()^]/.test(character) ? "^" + character : character;
    }
  }
  return escaped;
}

function parseLiteralCmdSetAssignment(
  raw: string,
  requireLiteral: boolean,
): CmdSetAssignment | null {
  if (!raw.startsWith('"') || !raw.endsWith('"') || /[\r\n\0]/.test(raw)) {
    return null;
  }
  const encoded = raw.slice(1, -1);
  let quoted = true;
  let assignment = "";
  for (let index = 0; index < encoded.length; index++) {
    const character = encoded.charAt(index);
    if (character === "%") {
      if (encoded.charAt(++index) !== "%") {
        return null;
      }
      assignment += "%";
    } else if (character === '"') {
      quoted = !quoted;
      assignment += character;
    } else if (!quoted && character === "^") {
      const escaped = encoded.charAt(++index);
      if (!escaped || !/[&|<>()^]/.test(escaped)) {
        return null;
      }
      assignment += escaped;
    } else {
      if (!quoted && /[&|<>()]/.test(character)) {
        return null;
      }
      assignment += character;
    }
  }
  if (escapeLiteralCmdSetAssignment(assignment) !== encoded) {
    return null;
  }
  const index = assignment.indexOf("=");
  const key = assignment.slice(0, index);
  if (index <= 0 || !key || key !== key.trim()) {
    return null;
  }
  return { key: requireLiteral ? key.toUpperCase() : key, value: assignment.slice(index + 1) };
}

function unescapeCmdSetAssignmentComponent(value: string): string {
  return value.replace(/\^([\^"!])|%%/g, (_match, escaped: string | undefined) => escaped ?? "%");
}

export function parseCmdSetAssignment(
  line: string,
  requireLiteral = false,
  options: { delayedExpansion?: boolean } = {},
): CmdSetAssignment | null {
  if (options.delayedExpansion === false && line.trimStart().startsWith('"')) {
    return parseLiteralCmdSetAssignment(line.trimStart(), requireLiteral);
  }
  const raw = requireLiteral ? line.trimStart() : line.trim();
  if (!raw) {
    return null;
  }
  const quoted = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2;
  const assignment = quoted ? raw.slice(1, -1) : raw;
  const index = assignment.indexOf("=");
  if (index <= 0) {
    return null;
  }
  const key = assignment.slice(0, index).trim();
  const value = requireLiteral ? assignment.slice(index + 1) : assignment.slice(index + 1).trim();
  if (!key) {
    return null;
  }
  // Unmarked installed scripts retain their legacy recovery/strict-read contract.
  if (
    requireLiteral &&
    (key !== assignment.slice(0, index) ||
      /[%!^"]/.test(assignment.replace(/%%/g, "")) ||
      (!quoted && (assignment.startsWith("/") || /[&|<>()]/.test(assignment))))
  ) {
    return null;
  }
  if (!quoted && !requireLiteral) {
    return { key, value };
  }
  return {
    key: unescapeCmdSetAssignmentComponent(requireLiteral ? key.toUpperCase() : key),
    value: unescapeCmdSetAssignmentComponent(value),
  };
}

/** Render one SET assignment for a batch file that disables delayed expansion. */
export function renderCmdSetAssignment(key: string, value: string): string {
  assertNoCmdLineBreak(key, "Environment variable name");
  assertNoCmdLineBreak(value, "Environment variable value");
  if (key.includes("\0") || value.includes("\0")) {
    throw new Error("Environment assignments cannot contain NUL in Windows task scripts.");
  }
  return `set "${escapeLiteralCmdSetAssignment(`${key}=${value}`)}"`;
}
