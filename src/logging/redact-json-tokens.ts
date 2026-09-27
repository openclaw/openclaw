import { expectDefined } from "@openclaw/normalization-core";
import type { RedactionEdit } from "./redact-edit-composition.js";

type RedactionScalarOrigin = { structured: boolean; primitiveMask: boolean };
export type RedactionOrigins = {
  value: RedactionScalarOrigin;
  children: Map<string, RedactionOrigins>;
};
export type RedactionField = {
  origin: RedactionScalarOrigin;
  key: string;
  path: readonly string[];
  objectPath: boolean;
  isKey: boolean;
  string: boolean;
  value: string;
};
export type ScalarToken = RedactionField & {
  raw?: boolean;
  deferEncoding?: boolean;
  start: number;
  end: number;
  escaped: boolean;
  boundaries?: Map<number, number>;
  encodedBoundaries?: number[];
  rootKey?: string;
  rootValueStart?: number;
  edits: RedactionEdit[];
  projectedEdits: RedactionEdit[];
  currentValue: string;
  currentStart: number;
  currentEnd: number;
  currentRaw?: string;
  encodedEdits?: EncodedEdit[];
  pending?: RedactionEdit[];
};

export type EncodedEdit = {
  start: number;
  end: number;
  decodedStart: number;
  decodedEnd: number;
  sourceEnd: number;
  sourceDecodedEnd: number;
  replacement: string;
};

type FieldContext = Pick<RedactionField, "key" | "path" | "objectPath"> & {
  origins?: RedactionOrigins;
  origin: RedactionScalarOrigin;
  rootKey?: string;
  rootValueStart?: number;
};
type JsonContainer = {
  array: boolean;
  nextIndex: number;
  context: FieldContext;
  field?: FieldContext;
  start: number;
  tokenStart: number;
};

const JSON_TOKEN_RE = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]]/g;

export function readScalarTokens(text: string, origins: RedactionOrigins): ScalarToken[] {
  const tokens: ScalarToken[] = [];
  const containers: JsonContainer[] = [];
  const root: FieldContext = {
    key: "",
    path: [],
    origins,
    origin: origins.value,
    objectPath: true,
  };
  const valueContext = (parent: JsonContainer | undefined): FieldContext =>
    !parent
      ? root
      : parent.array
        ? {
            ...parent.context,
            origin: parent.context.origins?.value ?? parent.context.origin,
            origins: parent.context.origins?.children.get(String(parent.nextIndex++)),
          }
        : expectDefined(parent.field, "JSON object field context");
  for (const match of text.matchAll(JSON_TOKEN_RE)) {
    const raw = match[0];
    const parent = containers.at(-1);
    if (raw === "{" || raw === "[") {
      const context = valueContext(parent);
      const array = raw === "[";
      containers.push({
        array,
        nextIndex: 0,
        context: array ? { ...context, objectPath: false } : context,
        start: match.index,
        tokenStart: tokens.length,
      });
      continue;
    }
    if (raw === "}" || raw === "]") {
      const container = expectDefined(containers.pop(), "JSON container");
      if (container.tokenStart === tokens.length) {
        const end = match.index + 1;
        const value = text.slice(container.start, end);
        tokens.push({
          ...container.context,
          isKey: false,
          string: false,
          value,
          start: container.start,
          end,
          escaped: false,
          edits: [],
          projectedEdits: [],
          currentValue: value,
          currentStart: container.start,
          currentEnd: end,
        });
      }
      continue;
    }
    const start = match.index;
    const end = start + raw.length;
    const string = raw.startsWith('"');
    const value: string = string ? JSON.parse(raw) : raw;
    let next = end;
    while (
      text[next] === " " ||
      text[next] === "\t" ||
      text[next] === "\r" ||
      text[next] === "\n"
    ) {
      next += 1;
    }
    const isKey = string && text[next] === ":";
    let context: FieldContext;
    if (isKey) {
      const container = expectDefined(parent, "JSON property container");
      const inherited = container.context;
      context = {
        key: "",
        path: [],
        origin: inherited.origin,
        objectPath: false,
        rootKey: inherited.rootKey,
        rootValueStart: inherited.rootValueStart,
      };
      let valueStart = next + 1;
      while (
        text[valueStart] === " " ||
        text[valueStart] === "\t" ||
        text[valueStart] === "\r" ||
        text[valueStart] === "\n"
      ) {
        valueStart += 1;
      }
      container.field = {
        key: value,
        path: [...inherited.path, value],
        origins: inherited.origins?.children.get(value),
        origin: inherited.origins?.value ?? inherited.origin,
        objectPath: inherited.objectPath,
        rootKey: containers.length === 1 ? value : inherited.rootKey,
        rootValueStart: containers.length === 1 ? valueStart : inherited.rootValueStart,
      };
    } else {
      context = valueContext(parent);
    }
    const origin: RedactionScalarOrigin = isKey
      ? { structured: false, primitiveMask: false }
      : (context.origins?.value ?? context.origin);
    tokens.push({
      ...context,
      origin,
      start,
      end,
      isKey,
      string,
      value,
      escaped: string && raw.includes("\\"),
      edits: [],
      projectedEdits: [],
      currentValue: value,
      currentStart: start,
      currentEnd: end,
    });
  }
  return tokens;
}

export function readBatchTokens(
  input: string,
  origins: RedactionOrigins,
  preserveLines = false,
): ScalarToken[] {
  const tokens: ScalarToken[] = [];
  let offset = 0;
  for (const line of input.split("\n")) {
    let json = false;
    try {
      JSON.parse(line);
      json = true;
    } catch {
      // Historical logs and journal output can mix JSON records with raw text.
    }
    if (json) {
      for (const token of readScalarTokens(line, origins)) {
        token.deferEncoding = !token.string;
        token.start += offset;
        token.end += offset;
        token.currentStart += offset;
        token.currentEnd += offset;
        tokens.push(token);
      }
    } else {
      const previous = tokens.at(-1);
      if (!preserveLines && previous?.raw && previous.end + 1 === offset) {
        previous.value += `\n${line}`;
        previous.currentValue = previous.value;
        previous.end = previous.currentEnd = offset + line.length;
      } else {
        tokens.push({
          raw: true,
          origin: origins.value,
          key: "",
          path: [],
          objectPath: false,
          isKey: false,
          string: false,
          value: line,
          escaped: false,
          start: offset,
          end: offset + line.length,
          currentStart: offset,
          currentEnd: offset + line.length,
          currentValue: line,
          edits: [],
          projectedEdits: [],
        });
      }
    }
    offset += line.length + 1;
  }
  return tokens;
}
