import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parse } from "acorn";

type Asset = { name: string; contents: Uint8Array };
type Reference = { name: string; start: number; end: number };

/** The immutable generation directory owns content identity; chunk names only own graph identity. */
export function nameControlUiChunks(files: Asset[]): Asset[] {
  const assets = new Map(files.map((file) => [file.name, file]));
  const references = new Map<string, Reference[]>();
  for (const file of files) {
    if (!file.name.endsWith(".js")) {
      continue;
    }
    const found: Reference[] = [];
    const visit = (node: unknown): void => {
      if (!isRecord(node)) {
        return;
      }
      if (
        node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "ImportExpression"
      ) {
        const source = node.source;
        if (
          isRecord(source) &&
          source.type === "Literal" &&
          typeof source.value === "string" &&
          source.value.startsWith("./") &&
          assets.has(source.value.slice(2)) &&
          typeof source.start === "number" &&
          typeof source.end === "number"
        ) {
          found.push({ name: source.value.slice(2), start: source.start, end: source.end });
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const child of value) {
            visit(child);
          }
        } else {
          visit(value);
        }
      }
    };
    visit(
      parse(Buffer.from(file.contents).toString("utf8"), {
        ecmaVersion: "latest",
        sourceType: "module",
      }),
    );
    references.set(
      file.name,
      found.toSorted((a, b) => a.start - b.start),
    );
  }

  const names = new Map<string, string>();
  const visit = (name: string): void => {
    if (names.has(name)) {
      return;
    }
    // Import order is observable, including distinct byte-identical modules.
    // Assign before descent so cycles retain their exact module identities.
    names.set(name, name === "index.js" ? name : "chunk-" + names.size + ".js");
    for (const reference of references.get(name) ?? []) {
      visit(reference.name);
    }
  };
  visit("index.js");
  return files
    .map((file) => {
      if (!file.name.endsWith(".js")) {
        return file;
      }
      const name = names.get(file.name);
      if (!name) {
        throw new Error("Control UI JavaScript output is not reachable from its entrypoint.");
      }
      let contents = Buffer.from(file.contents).toString("utf8");
      for (const reference of (references.get(file.name) ?? []).toReversed()) {
        contents =
          contents.slice(0, reference.start) +
          JSON.stringify("./" + names.get(reference.name)) +
          contents.slice(reference.end);
      }
      return { name, contents: Buffer.from(contents) };
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));
}
