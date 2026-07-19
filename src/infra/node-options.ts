export function parseNodeOptionsTokens(nodeOptions: string): string[] | null {
  // Match Node's NODE_OPTIONS splitter: space delimiters, double quotes, and
  // backslash escapes only inside quotes. Other shell quoting does not apply.
  const tokens: string[] = [];
  let token = "";
  let inQuotes = false;
  let tokenStarted = false;
  for (let index = 0; index < nodeOptions.length; index += 1) {
    let char = nodeOptions[index];
    if (char === "\\" && inQuotes) {
      index += 1;
      if (index >= nodeOptions.length) {
        return null;
      }
      char = nodeOptions[index];
    } else if (char === " " && !inQuotes) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    } else if (char === '"') {
      inQuotes = !inQuotes;
      tokenStarted = true;
      continue;
    }
    token += char;
    tokenStarted = true;
  }
  if (inQuotes) {
    return null;
  }
  if (tokenStarted) {
    tokens.push(token);
  }
  return tokens;
}
