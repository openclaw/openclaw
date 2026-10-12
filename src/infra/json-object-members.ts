/** Read JSON object members without normalizing number spelling or compound values. */
export function readJsonObjectMembers(json: string): Map<string, string> {
  JSON.parse(json);
  const tokens = json.match(/"(?:[^"\\]|\\[\s\S])*"|[{}[\],:]|[^\s{}[\],:]+/gu) ?? [];
  const members = new Map<string, string>();
  if (tokens[0] !== "{") {
    return members;
  }
  for (let i = 1; ;) {
    const keyToken = tokens[i];
    if (keyToken === undefined || keyToken === "}") {
      break;
    }
    const key: unknown = JSON.parse(keyToken);
    i += 2;
    const start = i;
    let depth = 0;
    do {
      const token = tokens[i++];
      if (token === "{" || token === "[") {
        depth++;
      } else if (token === "}" || token === "]") {
        depth--;
      }
    } while (depth > 0);
    // SQLite's path lookup selects the first duplicate object member.
    if (typeof key === "string" && !members.has(key)) {
      members.set(key, tokens.slice(start, i).join(""));
    }
    if (tokens[i] === ",") {
      i++;
    }
  }
  return members;
}
