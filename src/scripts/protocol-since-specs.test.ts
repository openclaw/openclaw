import { describe, expect, it } from "vitest";
import {
  classifyMethodSpecs,
  collectSnapshotMethodSpecs,
  snapshotReader,
} from "../../scripts/lib/protocol-since-specs.mjs";
const root = "src/core.ts";
const row = (name = "test.new", since = "2026.10") =>
  JSON.stringify([name, "family", "operator.read", since]);
const table = (body: string) => "export const CORE_GATEWAY_METHOD_SPECS=[" + body + "] as const;";
const scan = (files: Record<string, string>) =>
  collectSnapshotMethodSpecs(root, (file) => {
    if (!(file in files)) {
      throw new Error("missing snapshot file " + file);
    }
    return files[file]!;
  });
const imported = (contents: string, extra = ""): Record<string, string> => ({
  [root]: 'import { ROWS as importedRows } from "./rows.js";' + table(extra + "...importedRows"),
  "src/rows.ts": contents,
});
describe("canonical method table static extraction", () => {
  it("validates named imported/exported aliases with the inline path", () => {
    expect(
      scan(imported("const internal=[" + row() + "]; export {internal as ROWS};"))[0]?.name,
    ).toBe("test.new");
  });
  it("unwraps const/satisfies arrays without evaluating them", () => {
    expect(scan(imported("export const ROWS=([(" + row() + ")]) as const;"))).toHaveLength(1);
  });
  it("classifies old baseline rows and new imported rows using the selected base snapshot", () => {
    const base = scan({ [root]: table(row("old", "2026.9")) });
    const current = scan(
      imported("export const ROWS=[" + row() + "];", row("old", "2026.9") + ","),
    );
    const result = classifyMethodSpecs(current, base, "2026.10");
    expect(result.newMethods.map((x) => x.name)).toEqual(["test.new"]);
    expect(result.violations).toEqual([]);
  });
  it.each([undefined, "2026.9"])("rejects newly extracted missing/wrong vintage %s", (since) => {
    const current = scan(
      imported("export const ROWS=" + JSON.stringify([{ name: "new", since }]) + ";"),
    );
    expect(classifyMethodSpecs(current, [], "2026.10").violations).toHaveLength(1);
  });
  it("rejects duplicate names across inline and extracted entries", () => {
    expect(() => scan(imported("export const ROWS=[" + row() + "];", row() + ","))).toThrow(
      "Duplicate",
    );
  });
  it.each([
    ["export let ROWS=[" + row() + "];", "const"],
    ["export const ROWS=makeRows();", "static const array"],
    ["export const OTHER=[];", "unresolved"],
    ["export const ROWS=[]; export {ROWS};", "ambiguous"],
    ["export const ROWS=[...makeRows()];", "dynamic"],
    ["const ROWS=[];", "unresolved"],
  ])("rejects unresolved/ambiguous/dynamic exported table %s", (code, error) => {
    expect(() => scan(imported(code))).toThrow(error);
  });
  it("rejects missing imported snapshot files", () => {
    const files = imported("");
    delete files["src/rows.ts"];
    expect(() => scan(files)).toThrow("missing snapshot");
  });
  it("rejects import cycles", () => {
    const files = imported('import {BACK} from "./back.js"; export const ROWS=[...BACK];');
    files["src/back.ts"] = 'import {ROWS} from "./rows.js"; export const BACK=[...ROWS];';
    expect(() => scan(files)).toThrow("Cyclic");
  });
  it("rejects namespace and default imports rather than silently omitting rows", () => {
    for (const prefix of ['import * as rows from "./rows.js";', 'import rows from "./rows.js";']) {
      expect(() =>
        scan({ [root]: prefix + table("...rows"), "src/rows.ts": "export const ROWS=[];" }),
      ).toThrow("unresolved");
    }
  });
  it("rejects nonliteral method names in extracted tables", () => {
    expect(() =>
      scan(imported('export const ROWS=[[name,"family","operator.read","2026.10"]];')),
    ).toThrow("string literal names");
  });
  it("reads staged root and imports from the same index despite differing worktree contents", () => {
    const staged = imported("export const ROWS=[" + row() + "];");
    const working = imported("export const ROWS=[...run()];");
    const commands: string[][] = [];
    const read = snapshotReader(
      { kind: "index" },
      (file) => working[file]!,
      (args) => {
        commands.push(args);
        const file = args[1]!.slice(1);
        if (!(file in staged)) {
          throw new Error("missing index");
        }
        return staged[file]!;
      },
    );
    expect(collectSnapshotMethodSpecs(root, read)).toHaveLength(1);
    expect(commands).toEqual([
      ["show", ":src/core.ts"],
      ["show", ":src/rows.ts"],
    ]);
  });
  it.each([{ kind: "index" } as const, { kind: "tree", ref: "base" } as const])(
    "never falls back to worktree for a missing %j import",
    (snapshot) => {
      const staged = imported("");
      delete staged["src/rows.ts"];
      let workingReads = 0;
      const read = snapshotReader(
        snapshot,
        () => {
          workingReads++;
          return "export const ROWS=[];";
        },
        (args) => {
          const file = args[1]!.slice(args[1]!.indexOf(":") + 1);
          if (!(file in staged)) {
            throw new Error("missing selected snapshot");
          }
          return staged[file]!;
        },
      );
      expect(() => collectSnapshotMethodSpecs(root, read)).toThrow("missing selected");
      expect(workingReads).toBe(0);
    },
  );
  it("reads baseline root and imported rows at the same base tree", () => {
    const files = imported("export const ROWS=[" + row("old", "2026.9") + "];");
    const commands: string[][] = [];
    const read = snapshotReader(
      { kind: "tree", ref: "base" },
      () => {
        throw new Error("wrong tree");
      },
      (args) => {
        commands.push(args);
        return files[args[1]!.slice(5)]!;
      },
    );
    expect(collectSnapshotMethodSpecs(root, read)[0]?.since).toBe("2026.9");
    expect(commands).toEqual([
      ["show", "base:src/core.ts"],
      ["show", "base:src/rows.ts"],
    ]);
  });
});
