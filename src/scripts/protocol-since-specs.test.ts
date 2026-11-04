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

describe("canonical object-row metadata is static and unambiguous", () => {
  const values = { name: '"new.method"', since: '"2026.10"', compatibilityRestored: "false" };
  const defaults = { name: '"new.method"', since: '"2026.10"', compatibilityRestored: "false" };
  const object = (key: keyof typeof defaults, field: string, first = false) => {
    const other = Object.entries(defaults)
      .filter(([name]) => name !== key)
      .map(([name, value]) => name + ":" + value);
    return "{" + [...(first ? [field] : []), ...other, ...(!first ? [field] : [])].join(",") + "}";
  };
  const parse = (
    objectRow: string,
    metadata = '{name:"old.method",since:"2026.9",compatibilityRestored:true}',
  ) =>
    scan({
      [root]:
        "const metadata:Record<string,unknown>=" +
        metadata +
        '; const key="since"; const name="new.method"; const since="2026.10"; const compatibilityRestored=false;' +
        table(objectRow),
    });
  it.each(["name", "since", "compatibilityRestored"] as const)(
    "rejects spread overrides of %s before or after literals",
    (key) => {
      const overridingValue =
        key === "name" ? '"old.method"' : key === "since" ? '"2026.9"' : "true";
      for (const first of [true, false]) {
        const literal = Object.entries(values)
          .map(([name, value]) => name + ":" + value)
          .join(",");
        expect(() =>
          parse(
            "{" + (first ? "...metadata," + literal : literal + ",...metadata") + "}",
            "{" + key + ":" + overridingValue + "}",
          ),
        ).toThrow();
      }
    },
  );
  it.each(["name", "since", "compatibilityRestored"] as const)(
    "rejects computed %s keys even when their value is literal",
    (key) => {
      for (const first of [true, false]) {
        for (const computed of ['["' + key + '"]', "[key]"]) {
          expect(() => parse(object(key, computed + ":" + values[key], first))).toThrow();
        }
      }
    },
  );
  it.each(["name", "since", "compatibilityRestored"] as const)(
    "rejects duplicate identifier/quoted %s properties in either order",
    (key) => {
      for (const first of [true, false]) {
        const fields = first
          ? key + ":" + values[key] + ',"' + key + '":' + values[key]
          : '"' + key + '":' + values[key] + "," + key + ":" + values[key];
        expect(() => parse(object(key, fields))).toThrow();
      }
    },
  );
  it.each(["name", "since", "compatibilityRestored"] as const)(
    "rejects present dynamic or shorthand %s metadata",
    (key) => {
      for (const field of [key + ":" + key, key, key + ":undefined", key + ":null", key + ":0"]) {
        expect(() => parse(object(key, field))).toThrow();
      }
    },
  );
  it.each(["name", "since", "compatibilityRestored"] as const)(
    "rejects method/accessor %s metadata instead of treating it as absent",
    (key) => {
      for (const field of [
        key + "(){return " + values[key] + ";}",
        "get " + key + "(){return " + values[key] + ";}",
        "set " + key + "(value){}",
      ]) {
        expect(() => parse(object(key, field))).toThrow();
      }
    },
  );
  it("preserves optional metadata absence, literal false, and historical literal true", () => {
    const absent = parse('{name:"new.method",since:"2026.10"}');
    expect(absent[0]?.compatibilityRestored).toBe(false);
    expect(parse('{name:"new.method"}')[0]?.since).toBeUndefined();
    expect(
      parse('{name:"new.method",since:"2026.10",compatibilityRestored:false}')[0]
        ?.compatibilityRestored,
    ).toBe(false);
    const restored = parse('{name:"restored.method",since:"<=2026.7",compatibilityRestored:true}');
    expect(classifyMethodSpecs(restored, [], "2026.10").violations).toEqual([]);
  });
  it("rejects wrong literal metadata types", () => {
    for (const invalidRow of [
      '{name:true,since:"2026.10"}',
      '{name:"new.method",since:false}',
      '{name:"new.method",since:"2026.10",compatibilityRestored:"true"}',
    ]) {
      expect(() => parse(invalidRow)).toThrow();
    }
  });
});

describe("tuple policy metadata shares the strict boundary", () => {
  const tuple = (policy?: string, since = "<=2026.9") =>
    '["new.method","f","a",' +
    JSON.stringify(since) +
    (policy === undefined ? "" : "," + policy) +
    "]";
  const parsePolicy = (policy?: string, prefix = "", since = "<=2026.9") =>
    scan({
      [root]:
        'const runtimeOverrides:Record<string,unknown>={compatibilityRestored:false};const key="compatibilityRestored";const dynamic=true;const compatibilityRestored=true;' +
        prefix +
        table(tuple(policy, since)),
    });
  it("rejects the reviewed true-then-spread false override", () => {
    expect(() => parsePolicy("{compatibilityRestored:true,...runtimeOverrides}")).toThrow();
  });
  it.each([true, false])("rejects metadata spread before/after a literal (%s)", (first) => {
    expect(() =>
      parsePolicy(
        first
          ? "{...runtimeOverrides,compatibilityRestored:true}"
          : "{compatibilityRestored:true,...runtimeOverrides}",
      ),
    ).toThrow();
  });
  it.each(['["compatibilityRestored"]', "[key]"])("rejects computed tuple metadata %s", (key) => {
    expect(() => parsePolicy("{compatibilityRestored:true," + key + ":false}")).toThrow();
  });
  it.each([
    'compatibilityRestored:true,"compatibilityRestored":false',
    '"compatibilityRestored":false,compatibilityRestored:true',
  ])("rejects duplicate tuple metadata aliases %s", (fields) => {
    expect(() => parsePolicy("{" + fields + "}")).toThrow();
  });
  it.each([
    "compatibilityRestored:dynamic",
    "compatibilityRestored",
    "compatibilityRestored:undefined",
    "compatibilityRestored:null",
    "compatibilityRestored:0",
    'compatibilityRestored:"true"',
    "get compatibilityRestored(){return true;}",
    "set compatibilityRestored(value){}",
    "compatibilityRestored(){return true;}",
  ])("rejects unresolved/nonliteral/method tuple metadata %s", (field) => {
    expect(() => parsePolicy("{" + field + "}")).toThrow();
  });
  it.each(["unknownPolicy", "choosePolicy()", "dynamic?{}:{}", "undefined", "null", "42"])(
    "rejects unsupported present policy expression %s",
    (expression) => {
      expect(() => parsePolicy(expression)).toThrow();
    },
  );
  it("preserves absent, empty, and literal boolean tuple policy metadata", () => {
    expect(parsePolicy()[0]?.compatibilityRestored).toBe(false);
    expect(parsePolicy("{}")[0]?.compatibilityRestored).toBe(false);
    expect(parsePolicy("{compatibilityRestored:false}")[0]?.compatibilityRestored).toBe(false);
    expect(
      classifyMethodSpecs(parsePolicy("{compatibilityRestored:true}"), [], "2026.10").violations,
    ).toEqual([]);
    expect(
      classifyMethodSpecs(parsePolicy("{compatibilityRestored:false}"), [], "2026.10").violations,
    ).toHaveLength(1);
  });
  it("resolves a local static const policy instead of erasing present metadata", () => {
    expect(
      parsePolicy("POLICY", "const POLICY={compatibilityRestored:true} as const;")[0]
        ?.compatibilityRestored,
    ).toBe(true);
  });
  it("preserves canonical non-metadata policy composition only when absence is statically proven", () => {
    expect(
      parsePolicy(
        "{...BASE,shareKey:handler}",
        "const BASE={profileDependent:true};const handler=()=>null;",
        "2026.10",
      )[0]?.compatibilityRestored,
    ).toBe(false);
    expect(() => parsePolicy("{...BASE}", "const BASE={compatibilityRestored:true};")).toThrow();
  });
  it.each([{ kind: "index" } as const, { kind: "tree", ref: "base" } as const])(
    "resolves policy imports from the same selected %j snapshot",
    (snapshot) => {
      const files: Record<string, string> = {
        [root]: 'import {POLICY as selected} from "./policy.js";' + table(tuple("selected")),
        "src/policy.ts": "export const POLICY={compatibilityRestored:true} as const;",
      };
      const reads: string[][] = [];
      const read = snapshotReader(
        snapshot,
        () => {
          throw new Error("worktree read");
        },
        (args) => {
          reads.push(args);
          const file = args[1]!.slice(args[1]!.indexOf(":") + 1);
          if (!(file in files)) {
            throw new Error("missing selected snapshot");
          }
          return files[file]!;
        },
      );
      expect(collectSnapshotMethodSpecs(root, read)[0]?.compatibilityRestored).toBe(true);
      expect(reads).toHaveLength(2);
      delete files["src/policy.ts"];
      expect(() => collectSnapshotMethodSpecs(root, read)).toThrow("missing selected snapshot");
    },
  );
});
