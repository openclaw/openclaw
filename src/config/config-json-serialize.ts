// Serializes an owned config document exactly like `JSON.stringify(value, null, 2)`,
// but on an explicit work stack: document nesting costs heap rather than call
// frames, so a schema-valid deep config cannot crash the write path with a
// RangeError. The output must stay byte-identical to the platform serializer:
// config hashes, change detection, and reread snapshots all depend on the
// exact bytes, so no formatting shortcut is allowed here.

interface SerializeEntry {
  // Object members carry their authored key for `": "` output and the `toJSON`
  // argument; array items carry `null` because they emit no key prefix.
  readonly key: string | null;
  readonly jsonKey: string;
  readonly value: unknown;
}

interface EntriesFrame {
  readonly kind: "entries";
  readonly entries: readonly SerializeEntry[];
  next: number;
  readonly depth: number;
  readonly closer: string;
  readonly openText: string;
  readonly emptyText: string;
  readonly container: object;
  // The entries frame this container value belongs to, so finishing this
  // container marks the next sibling entry with a comma separator.
  readonly owner: EntriesFrame | null;
  // Emitted once the first serializable member is reached: a container whose
  // members are all skipped must render as `{}` / `[]` with no key prefix.
  prefix: string;
  opened: boolean;
  separatorPending: boolean;
}

interface ValueFrame {
  readonly kind: "value";
  readonly value: unknown;
  readonly depth: number;
  readonly prefix: string;
  readonly owner: EntriesFrame | null;
}

type SerializeFrame = EntriesFrame | ValueFrame;

function quoteJsonString(text: string): string {
  let out = '"';
  let segmentStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    let escaped: string | null = null;
    if (code === 0x22) {
      escaped = '\\"';
    } else if (code === 0x5c) {
      escaped = "\\\\";
    } else if (code === 0x08) {
      escaped = "\\b";
    } else if (code === 0x09) {
      escaped = "\\t";
    } else if (code === 0x0a) {
      escaped = "\\n";
    } else if (code === 0x0c) {
      escaped = "\\f";
    } else if (code === 0x0d) {
      escaped = "\\r";
    } else if (code < 0x20) {
      escaped = `\\u${code.toString(16).padStart(4, "0")}`;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        // A well-formed surrogate pair stays verbatim; skip both characters.
        index += 1;
        continue;
      }
      // A lone surrogate is escaped so the output stays well-formed JSON.
      escaped = `\\u${code.toString(16).padStart(4, "0")}`;
    }
    if (escaped !== null) {
      out += text.slice(segmentStart, index) + escaped;
      segmentStart = index + 1;
    }
  }
  return out + text.slice(segmentStart) + '"';
}

function scalarText(value: unknown): string {
  if (typeof value === "string") {
    return quoteJsonString(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  // Array items that are `undefined`, functions, or symbols serialize as null.
  return "null";
}

function isPlainContainer(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveToJSON(value: unknown, jsonKey: string): unknown {
  // The platform serializer re-applies `toJSON` until the result is no longer
  // a toJSON-bearing object. Config values come from parsed JSON and never
  // carry one, so the bound only guards a pathological hand-built document.
  let current = value;
  for (let applied = 0; applied < 1000; applied += 1) {
    if (!isPlainContainer(current)) {
      return current;
    }
    const toJSON = current.toJSON;
    if (typeof toJSON !== "function") {
      return current;
    }
    current = toJSON.call(current, jsonKey);
  }
  throw new TypeError("Converting circular structure to JSON");
}

function collectEntries(container: object): SerializeEntry[] {
  if (Array.isArray(container)) {
    const entries: SerializeEntry[] = [];
    for (let index = 0; index < container.length; index += 1) {
      entries.push({ key: null, jsonKey: String(index), value: container[index] });
    }
    return entries;
  }
  const entries: SerializeEntry[] = [];
  for (const key of Object.keys(container)) {
    // SAFETY: the array branch above returned, so this non-array object is a plain record.
    entries.push({ key, jsonKey: key, value: (container as Record<string, unknown>)[key] });
  }
  return entries;
}

export function serializeConfigJson(value: object): string {
  const out: string[] = [];
  const indents: string[] = [""];
  const indentAt = (depth: number): string => {
    while (indents.length <= depth) {
      indents.push(indents[indents.length - 1]! + "  ");
    }
    return indents[depth]!;
  };
  const stack: SerializeFrame[] = [{ kind: "value", value, depth: 0, prefix: "", owner: null }];
  const containersInFlight = new Set<object>();
  // The `{` / `[` opener is emitted lazily, once the first serializable member
  // is reached, so a container whose members are all skipped still renders as
  // `{}` / `[]` without its key prefix.
  const emitContainerOpen = (frame: EntriesFrame): void => {
    if (frame.opened) {
      return;
    }
    frame.opened = true;
    out.push(frame.prefix + frame.openText);
  };
  const entrySeparator = (frame: EntriesFrame): string => (frame.separatorPending ? ",\n" : "");
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) {
      break;
    }
    if (frame.kind === "entries") {
      if (frame.next >= frame.entries.length) {
        containersInFlight.delete(frame.container);
        if (frame.opened) {
          out.push("\n" + indentAt(frame.depth - 1) + frame.closer);
        } else {
          out.push(frame.prefix + frame.emptyText);
        }
        if (frame.owner) {
          frame.owner.separatorPending = true;
        }
        continue;
      }
      // Re-push the frame before its child value so the child is processed
      // first and the remaining entries resume right after it.
      stack.push(frame);
      const entry = frame.entries[frame.next]!;
      frame.next += 1;
      let resolved: unknown = entry.value;
      if (typeof resolved === "bigint") {
        throw new TypeError("Do not know how to serialize a BigInt");
      }
      if (isPlainContainer(resolved) && typeof resolved.toJSON === "function") {
        resolved = resolveToJSON(resolved, entry.jsonKey);
        if (typeof resolved === "bigint") {
          throw new TypeError("Do not know how to serialize a BigInt");
        }
      }
      if (
        resolved === undefined ||
        typeof resolved === "function" ||
        typeof resolved === "symbol"
      ) {
        // Object members with an unserializable value vanish; array items
        // collapse to null.
        if (entry.key !== null) {
          continue;
        }
        emitContainerOpen(frame);
        out.push(entrySeparator(frame) + indentAt(frame.depth) + "null");
        frame.separatorPending = true;
        continue;
      }
      emitContainerOpen(frame);
      out.push(
        entrySeparator(frame) +
          indentAt(frame.depth) +
          (entry.key === null ? "" : `${quoteJsonString(entry.key)}: `),
      );
      frame.separatorPending = true;
      stack.push({
        kind: "value",
        value: resolved,
        depth: frame.depth,
        prefix: "",
        owner: frame,
      });
      continue;
    }
    // Value frame: the prefix (separator, indent, key) is already resolved, so
    // the emitted bytes depend only on this value's shape.
    if (frame.value === null || typeof frame.value !== "object") {
      out.push(frame.prefix + scalarText(frame.value));
      if (frame.owner) {
        frame.owner.separatorPending = true;
      }
      continue;
    }
    if (containersInFlight.has(frame.value)) {
      throw new TypeError("Converting circular structure to JSON");
    }
    const entries = collectEntries(frame.value);
    const isList = Array.isArray(frame.value);
    containersInFlight.add(frame.value);
    stack.push({
      kind: "entries",
      entries,
      next: 0,
      depth: frame.depth + 1,
      closer: isList ? "]" : "}",
      openText: isList ? "[\n" : "{\n",
      emptyText: isList ? "[]" : "{}",
      container: frame.value,
      owner: frame.owner,
      prefix: frame.prefix,
      opened: false,
      separatorPending: false,
    });
  }
  return out.join("");
}
