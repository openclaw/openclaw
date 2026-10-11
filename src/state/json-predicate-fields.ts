export type JsonPredicateToken = {
  kind: "string" | "number" | "boolean" | "null" | "object" | "array";
  text: string;
};

/** Select raw root members without constructing objects for opaque JSON bodies. */
export function scanJsonObjectFields(json: string, fields: readonly string[]) {
  const first = new Map<string, JsonPredicateToken>();
  const last = new Map<string, JsonPredicateToken>();
  const wanted = new Set(fields);
  let offset = 0;
  let maximumDepth = 0;
  const whitespace = /[\t\n\r ]*/y;
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const stringPart = /["\\\u0000-\u001f]/g;
  const fail = (): never => {
    throw new SyntaxError("Invalid JSON predicate source");
  };
  const skipWhitespace = () => {
    whitespace.lastIndex = offset;
    whitespace.exec(json);
    offset = whitespace.lastIndex;
  };
  const string = () => {
    if (json[offset++] !== '"') {
      fail();
    }
    while (offset < json.length) {
      stringPart.lastIndex = offset;
      const match = stringPart.exec(json);
      if (!match) {
        fail();
      }
      offset = stringPart.lastIndex;
      if (match[0] === '"') {
        return;
      }
      if (match[0] !== "\\") {
        fail();
      }
      const escape = json[offset++];
      if (escape === "u") {
        if (!/^[0-9a-fA-F]{4}$/.test(json.slice(offset, offset + 4))) {
          fail();
        }
        offset += 4;
      } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
        fail();
      }
    }
    fail();
  };
  const value = (depth: number): JsonPredicateToken["kind"] => {
    skipWhitespace();
    const start = json[offset];
    maximumDepth = Math.max(maximumDepth, depth + (start === "{" || start === "[" ? 1 : 0));
    if (start === '"') {
      string();
      return "string";
    }
    if (start === "{" || start === "[") {
      const object = start === "{";
      const close = object ? "}" : "]";
      offset++;
      skipWhitespace();
      if (json[offset] === close) {
        offset++;
        return object ? "object" : "array";
      }
      while (offset < json.length) {
        let key: string | undefined;
        if (object) {
          const keyStart = offset;
          string();
          if (depth === 0) {
            key = JSON.parse(json.slice(keyStart, offset)) as string;
          }
          skipWhitespace();
          if (json[offset++] !== ":") {
            fail();
          }
        }
        skipWhitespace();
        const tokenStart = offset;
        const kind = value(depth + 1);
        if (key !== undefined) {
          // JSON1 path lookup terminates decoded labels at NUL; json_each keys do not.
          const nul = key.indexOf("\0");
          const firstKey = nul < 0 ? key : key.slice(0, nul);
          const keepFirst = wanted.has(firstKey) && !first.has(firstKey);
          const keepLast = wanted.has(key);
          if (keepFirst || keepLast) {
            const token = { kind, text: json.slice(tokenStart, offset) };
            if (keepFirst) {
              first.set(firstKey, token);
            }
            if (keepLast) {
              last.set(key, token);
            }
          }
        }
        skipWhitespace();
        const separator = json[offset++];
        if (separator === close) {
          return object ? "object" : "array";
        }
        if (separator !== ",") {
          fail();
        }
        skipWhitespace();
      }
      fail();
    }
    const literal =
      start === "t" ? "true" : start === "f" ? "false" : start === "n" ? "null" : undefined;
    if (literal && json.startsWith(literal, offset)) {
      offset += literal.length;
      return literal === "null" ? "null" : "boolean";
    }
    number.lastIndex = offset;
    if (!number.exec(json)) {
      fail();
    }
    offset = number.lastIndex;
    return "number";
  };
  try {
    value(0);
    skipWhitespace();
    // SQLite treats a NUL after the complete JSON document as the TEXT terminator.
    if (offset !== json.length && json[offset] !== "\0") {
      fail();
    }
    return { valid: true, maximumDepth, first, last };
  } catch {
    return {
      valid: false,
      maximumDepth,
      first: new Map<string, JsonPredicateToken>(),
      last: new Map<string, JsonPredicateToken>(),
    };
  }
}

export function readJsonPredicateScalar(
  token: JsonPredicateToken | undefined,
): string | number | boolean | null | undefined {
  return token && token.kind !== "object" && token.kind !== "array"
    ? (JSON.parse(token.text) as string | number | boolean | null)
    : undefined;
}
