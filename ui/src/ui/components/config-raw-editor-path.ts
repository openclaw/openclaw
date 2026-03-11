export type JsonPathSegment = string | number;
export type JsonPathBreadcrumb = {
  segment: JsonPathSegment;
  from: number;
};

type RootFrame = {
  kind: "root";
  path: JsonPathBreadcrumb[];
};

type ObjectFrame = {
  kind: "object";
  path: JsonPathBreadcrumb[];
  pendingKey: JsonPathBreadcrumb | null;
  expectingValue: boolean;
  lastPath: JsonPathBreadcrumb[];
};

type ArrayFrame = {
  kind: "array";
  path: JsonPathBreadcrumb[];
  index: number;
  expectingValue: boolean;
  lastPath: JsonPathBreadcrumb[];
  pendingFrom: number;
};

type Frame = RootFrame | ObjectFrame | ArrayFrame;

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t" || char === "\f";
}

function isIdentifierStart(char: string): boolean {
  return /[$_\p{ID_Start}]/u.test(char);
}

function isValueTokenStart(char: string): boolean {
  return isIdentifierStart(char) || /[-0-9.]/.test(char);
}

function isDelimiter(char: string): boolean {
  return (
    char === "" ||
    isWhitespace(char) ||
    char === "{" ||
    char === "}" ||
    char === "[" ||
    char === "]" ||
    char === ":" ||
    char === "," ||
    char === "'" ||
    char === '"' ||
    char === "/"
  );
}

function readQuotedString(source: string, start: number): { value: string; next: number } {
  const quote = source[start] ?? '"';
  let value = "";
  let index = start + 1;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (char === "\\") {
      value += source[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (char === quote) {
      return { value, next: index + 1 };
    }
    value += char;
    index += 1;
  }
  return { value, next: source.length };
}

function readBareToken(source: string, start: number): { value: string; next: number } {
  let index = start;
  while (index < source.length && !isDelimiter(source[index] ?? "")) {
    index += 1;
  }
  return { value: source.slice(start, index), next: index };
}

function skipTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (isWhitespace(char)) {
      index += 1;
      continue;
    }

    if (char === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index = Math.min(source.length, index + 2);
      continue;
    }

    return index;
  }
  return source.length;
}

function peekNextNonWhitespace(source: string, start: number): string {
  const index = skipTrivia(source, start);
  return source[index] ?? "";
}

function isObjectKeyToken(source: string, token: string, next: number): boolean {
  return token.length > 0 && peekNextNonWhitespace(source, next) === ":";
}

function createArrayIndexBreadcrumb(index: number, from: number): JsonPathBreadcrumb {
  return { segment: index, from };
}

function consumeValuePath(frame: Frame, from?: number): JsonPathBreadcrumb[] {
  if (frame.kind === "object") {
    if (frame.pendingKey === null) {
      return frame.path;
    }
    const path = [...frame.path, frame.pendingKey];
    frame.pendingKey = null;
    frame.expectingValue = false;
    frame.lastPath = path;
    return path;
  }
  if (frame.kind === "array") {
    const path = [
      ...frame.path,
      createArrayIndexBreadcrumb(frame.index, from ?? frame.pendingFrom),
    ];
    frame.index += 1;
    frame.expectingValue = false;
    frame.lastPath = path;
    return path;
  }
  return frame.path;
}

function currentFramePath(frame: Frame): JsonPathBreadcrumb[] {
  if (frame.kind === "object") {
    if (frame.pendingKey !== null) {
      return [...frame.path, frame.pendingKey];
    }
    return frame.lastPath.length > 0 ? frame.lastPath : frame.path;
  }
  if (frame.kind === "array") {
    if (frame.expectingValue) {
      return [...frame.path, createArrayIndexBreadcrumb(frame.index, frame.pendingFrom)];
    }
    return frame.lastPath.length > 0 ? frame.lastPath : frame.path;
  }
  return frame.path;
}

function readKeyTokenAtCursor(
  source: string,
  cursor: number,
): { value: string; next: number; from: number } | null {
  const char = source[cursor] ?? "";
  if (char === '"' || char === "'") {
    return { ...readQuotedString(source, cursor), from: cursor };
  }
  if (isValueTokenStart(char)) {
    return { ...readBareToken(source, cursor), from: cursor };
  }
  return null;
}

export function resolveJson5BreadcrumbsAt(source: string, offset: number): JsonPathBreadcrumb[] {
  const cursor = Math.max(0, Math.min(offset, source.length));
  const stack: Frame[] = [{ kind: "root", path: [] }];
  let activePath: JsonPathBreadcrumb[] = [];
  let index = 0;

  while (index < cursor) {
    const char = source[index] ?? "";

    if (isWhitespace(char)) {
      index += 1;
      continue;
    }

    if (char === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < cursor && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < cursor && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index = Math.min(cursor, index + 2);
      continue;
    }

    if (char === '"' || char === "'") {
      const token = readQuotedString(source, index);
      const frame = stack.at(-1);
      if (
        frame?.kind === "object" &&
        !frame.expectingValue &&
        isObjectKeyToken(source, token.value, token.next)
      ) {
        const key = { segment: token.value, from: index };
        frame.pendingKey = key;
        activePath = [...frame.path, key];
      } else if (frame && frame.kind !== "root") {
        activePath = consumeValuePath(frame, index);
      }
      index = token.next;
      continue;
    }

    if (char === "{") {
      const parent = stack.at(-1) ?? { kind: "root", path: [] };
      const path = consumeValuePath(parent, index);
      stack.push({
        kind: "object",
        path,
        pendingKey: null,
        expectingValue: false,
        lastPath: path,
      });
      activePath = path;
      index += 1;
      continue;
    }

    if (char === "[") {
      const parent = stack.at(-1) ?? { kind: "root", path: [] };
      const path = consumeValuePath(parent, index);
      stack.push({
        kind: "array",
        path,
        index: 0,
        expectingValue: true,
        lastPath: path,
        pendingFrom: index + 1,
      });
      activePath = path;
      index += 1;
      continue;
    }

    if (char === "}") {
      stack.pop();
      activePath = currentFramePath(stack.at(-1) ?? { kind: "root", path: [] });
      index += 1;
      continue;
    }

    if (char === "]") {
      stack.pop();
      activePath = currentFramePath(stack.at(-1) ?? { kind: "root", path: [] });
      index += 1;
      continue;
    }

    if (char === ":") {
      const frame = stack.at(-1);
      if (frame?.kind === "object" && frame.pendingKey !== null) {
        frame.expectingValue = true;
        activePath = [...frame.path, frame.pendingKey];
      }
      index += 1;
      continue;
    }

    if (char === ",") {
      const frame = stack.at(-1);
      if (frame?.kind === "object") {
        frame.pendingKey = null;
        frame.expectingValue = false;
        activePath = frame.path;
      } else if (frame?.kind === "array") {
        frame.expectingValue = true;
        frame.pendingFrom = index + 1;
        activePath = [...frame.path, createArrayIndexBreadcrumb(frame.index, frame.pendingFrom)];
      }
      index += 1;
      continue;
    }

    if (isValueTokenStart(char)) {
      const token = readBareToken(source, index);
      const frame = stack.at(-1);
      if (
        frame?.kind === "object" &&
        !frame.expectingValue &&
        isObjectKeyToken(source, token.value, token.next)
      ) {
        const key = { segment: token.value, from: index };
        frame.pendingKey = key;
        activePath = [...frame.path, key];
      } else if (frame && frame.kind !== "root") {
        activePath = consumeValuePath(frame, index);
      }
      index = token.next;
      continue;
    }

    index += 1;
  }

  const frame = stack.at(-1) ?? { kind: "root", path: [] };
  if (frame.kind === "object" && !frame.expectingValue && frame.pendingKey === null) {
    const keyAtCursor = readKeyTokenAtCursor(source, cursor);
    if (keyAtCursor && isObjectKeyToken(source, keyAtCursor.value, keyAtCursor.next)) {
      return [...frame.path, { segment: keyAtCursor.value, from: keyAtCursor.from }];
    }
  }

  return activePath.length > 0 ? activePath : currentFramePath(frame);
}

export function resolveJson5PathAt(source: string, offset: number): JsonPathSegment[] {
  return resolveJson5BreadcrumbsAt(source, offset).map((entry) => entry.segment);
}

export function formatJsonPath(path: JsonPathSegment[]): string {
  if (path.length === 0) {
    return "Root";
  }
  return path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : segment))
    .join(" > ");
}
