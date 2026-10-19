import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { collectIncludePathsRecursive } from "./includes-scan.js";
import {
  CircularIncludeError,
  ConfigIncludeError,
  MAX_INCLUDE_DEPTH,
  type ConfigIncludeResolutionEvent,
  type IncludeResolver,
  resolveConfigIncludes as resolveIncludes,
} from "./includes.js";

const ROOT_DIR = path.parse(process.cwd()).root;
const CONFIG_DIR = path.join(ROOT_DIR, "config");
const SHARED_DIR = path.join(ROOT_DIR, "shared");

const CONFIG_FILE = path.join(CONFIG_DIR, "openclaw.json");

function configPath(...parts: string[]) {
  return path.join(CONFIG_DIR, ...parts);
}

function createMockResolver(files: Record<string, unknown>): IncludeResolver {
  return {
    readFile: (filePath: string) => {
      if (filePath in files) {
        return JSON.stringify(files[filePath]);
      }
      throw new Error(`ENOENT: no such file: ${filePath}`);
    },
    parseJson: JSON.parse,
  };
}

function resolve(obj: unknown, files: Record<string, unknown> = {}) {
  return resolveIncludes(obj, CONFIG_FILE, createMockResolver(files));
}

async function writeFixture(filePath: string, content: unknown, raw = false) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, raw ? String(content) : JSON.stringify(content), "utf-8");
}

function includeChain(length: number) {
  return Object.fromEntries(
    Array.from({ length }, (_, i) => [
      configPath(`chain${i}.json`),
      i === length - 1 ? { done: true } : { $include: `./chain${i + 1}.json` },
    ]),
  );
}

function resolveWithEvents(obj: unknown, files: Record<string, unknown>) {
  const events: ConfigIncludeResolutionEvent[] = [];
  const resolver = createMockResolver(files);
  resolver.onIncludeResolved = (event) => events.push(event);
  return { result: resolveIncludes(obj, CONFIG_FILE, resolver), events };
}

function scan(configDir: string, parsed: unknown, allowedRoots?: string[]) {
  return collectIncludePathsRecursive({
    configPath: path.join(configDir, "openclaw.json"),
    parsed,
    allowedRoots,
  });
}

type IncludeFixture = {
  at: (name: string) => string;
  write: (name: string, content: unknown) => Promise<void>;
  configDir: string;
};

function withFiles(
  files: Record<string, unknown>,
  run: (fixture: IncludeFixture) => Promise<void>,
) {
  return () =>
    withTestDir({ prefix: "openclaw-includes-" }, async (root) => {
      const at = (name: string) => path.join(root, name);
      const write = (name: string, content: unknown) => writeFixture(at(name), content);
      const configDir = at("config");
      await fs.mkdir(configDir);
      for (const [name, content] of Object.entries(files)) {
        await write(name, content);
      }
      await run({ at, write, configDir });
    });
}

function expectIncludeError(run: () => unknown, pattern: RegExp): ConfigIncludeError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigIncludeError);
    expect(error).toMatchObject({ message: expect.stringMatching(pattern) });
    return error as ConfigIncludeError;
  }
  throw new Error("Expected ConfigIncludeError");
}

type IncludeFailure = [
  name: string,
  input: unknown,
  pattern: RegExp,
  files?: Record<string, unknown>,
  resolver?: Partial<IncludeResolver>,
  options?: Parameters<typeof resolveIncludes>[3],
];
const include = ($include: unknown) => ({ $include });
const validFile = { [configPath("valid.json")]: { valid: true } };
const siblingError = /Sibling keys require included content to be an object/;

it.each<IncludeFailure>([
  [
    "array include with siblings",
    { ...include("list.json"), extra: true },
    siblingError,
    { [configPath("list.json")]: ["a", "b"] },
  ],
  ["read failure", include("missing.json"), /Failed to read include file/],
  [
    "parse failure",
    include("bad.json"),
    /Failed to parse include file/,
    {},
    { readFile: () => "{ invalid json }" },
  ],
  ["scalar include", include(123), /expected string or array/, validFile],
  [
    "number in include array",
    include(["./valid.json", 123]),
    /expected string, got number/,
    validFile,
  ],
  ["null byte", include("./file\x00.json"), /null bytes?/i],
  ["double slash escape", include("//etc/passwd"), /escapes config directory/],
  ["maximum path length", include("a".repeat(4096)), /maximum length/],
  [
    "outside every allowed root",
    include(path.join(ROOT_DIR, "etc", "openclaw", "agents.json")),
    /escapes config directory/,
    {},
    {},
    { allowedRoots: [SHARED_DIR] },
  ],
])("rejects %s", (_name, input, pattern, files = {}, resolver = {}, options = {}) => {
  const io = { ...createMockResolver(files), ...resolver };
  expectIncludeError(() => resolveIncludes(input, CONFIG_FILE, io, options), pattern);
});

it("projects archived includes before enforcing the existing root boundary", () => {
  const source = path.join(ROOT_DIR, "old-install", "database.json");
  const restored = configPath("captured", "database.json");
  const resolver = {
    ...createMockResolver({ [restored]: { database: { engine: "postgres" } } }),
    mapPath: () => restored,
  };
  expect(resolveIncludes({ $include: source }, CONFIG_FILE, resolver)).toEqual({
    database: { engine: "postgres" },
  });
  expectIncludeError(
    () =>
      resolveIncludes({ $include: source }, CONFIG_FILE, {
        ...resolver,
        mapPath: () => source,
      }),
    /escapes config directory/,
  );
});

it("reports exact include ownership through arrays, nesting, and sibling overrides", () => {
  const files = {
    [configPath("first.json")]: { id: "first" },
    [configPath("second.json")]: { enabled: true },
    [configPath("third.json")]: { mode: "strict" },
  };
  const policy = { $include: ["./second.json", "./third.json"], enabled: false };
  const { result, events } = resolveWithEvents(
    { plugins: [include("./first.json"), { policy }] },
    files,
  );
  expect(result).toEqual({
    plugins: [{ id: "first" }, { policy: { enabled: false, mode: "strict" } }],
  });
  expect(events).toEqual([
    {
      path: ["plugins", "0"],
      value: { id: "first" },
      kind: "single",
      hasSiblingOverrides: false,
      hasArrayAncestor: true,
      targetPath: configPath("first.json"),
    },
    {
      path: ["plugins", "1", "policy"],
      value: { enabled: true, mode: "strict" },
      kind: "multiple",
      hasSiblingOverrides: true,
      hasArrayAncestor: true,
      targetPaths: [configPath("second.json"), configPath("third.json")],
    },
  ]);
});

it("reports the enclosing include after nested delegates at the same logical path", () => {
  const files = {
    [configPath("delegating.json")]: { $include: "./nested.json" },
    [configPath("nested.json")]: { mode: "nested" },
    [configPath("override.json")]: { mode: "override" },
  };
  const { result, events } = resolveWithEvents(
    { agents: { $include: ["./delegating.json", "./override.json"] } },
    files,
  );
  expect(result).toEqual({ agents: { mode: "override" } });
  const targets = [configPath("delegating.json"), configPath("override.json")];
  expect(
    events.map((event) => [event.path, event.kind, event.targetPath, event.targetPaths]),
  ).toEqual([
    [["agents"], "single", configPath("nested.json"), undefined],
    [["agents"], "multiple", undefined, targets],
  ]);
});

it("throws CircularIncludeError for circular includes", () => {
  const aPath = configPath("a.json"),
    bPath = configPath("b.json");
  const circular = expectIncludeError(
    () =>
      resolve(
        { $include: "./a.json" },
        {
          [aPath]: { $include: "./b.json" },
          [bPath]: { $include: "./a.json" },
        },
      ),
    /Circular include detected/,
  );
  expect(circular).toBeInstanceOf(CircularIncludeError);
  expect(circular).toMatchObject({ chain: expect.arrayContaining([CONFIG_FILE, aPath, bPath]) });
  expect(circular.message).toContain("a.json");
  expect(circular.message).toContain("b.json");
});

it("allows depth 10 but rejects depth 11", () => {
  expect(resolve({ $include: "./chain0.json" }, includeChain(10))).toEqual({ done: true });
  expectIncludeError(
    () => resolve({ $include: "./chain0.json" }, includeChain(11)),
    /Maximum include depth/,
  );
});

it.runIf(process.platform !== "win32")(
  "only reports includes the production resolver can safely open",
  withFiles(
    { "config/safe.json5": { safe: true }, "outside.json5": { outside: true } },
    async ({ at, configDir }) => {
      await fs.symlink(at("outside.json5"), at("config/outside-link.json5"));
      const includePaths = await scan(configDir, {
        $include: ["./safe.json5", "../outside.json5", "./outside-link.json5"],
      });
      expect(includePaths).toEqual([await fs.realpath(at("config/safe.json5"))]);
    },
  ),
);

it.runIf(process.platform !== "win32")(
  "keeps the original root boundary after a parent symlink swap",
  withFiles(
    {
      "trusted/outer.json5": { $include: "./nested.json5" },
      "trusted/nested.json5": { trusted: true },
      "outside/nested.json5": { escaped: true },
    },
    async ({ at }) => {
      const configLink = at("config-link");
      await fs.symlink(at("trusted"), configLink);
      let swapped = false;
      const resolver: IncludeResolver = {
        readFile: (filePath) => nodeFs.readFileSync(filePath, "utf-8"),
        parseJson: (raw) => {
          const parsed = JSON.parse(raw) as unknown;
          if (!swapped) {
            nodeFs.unlinkSync(configLink);
            nodeFs.symlinkSync(at("outside"), configLink);
            swapped = true;
          }
          return parsed;
        },
      };

      expect(() =>
        resolveIncludes(
          { $include: "./outer.json5" },
          path.join(configLink, "openclaw.json"),
          resolver,
        ),
      ).toThrow(/resolves outside config directory/);
    },
  ),
);

it(
  "honors explicitly allowed include roots",
  withFiles({}, async ({ at, configDir }) => {
    const sharedIncludePath = at("shared/shared.json5");
    await writeFixture(sharedIncludePath, "{ shared: true }\n", true);
    expect(await scan(configDir, { $include: sharedIncludePath }, [at("shared")])).toEqual([
      await fs.realpath(sharedIncludePath),
    ]);
  }),
);

it(
  "continues past rejected nested includes to later safe siblings",
  withFiles(
    {
      "config/nested/outer.json5": { $include: ["../../escaped.json5", "../safe.json5"] },
      "config/safe.json5": { safe: true },
      "escaped.json5": { escaped: true },
    },
    async ({ at, configDir }) => {
      expect(await scan(configDir, { $include: "./nested/outer.json5" })).toEqual([
        await fs.realpath(at("config/nested/outer.json5")),
        await fs.realpath(at("config/safe.json5")),
      ]);
    },
  ),
);

it(
  "revisits an include reached later at a shallower depth",
  withFiles(
    {
      "config/shared.json5": { $include: "./leaf.json5" },
      "config/leaf.json5": { leaf: true },
    },
    async ({ at, write, configDir }) => {
      for (let index = 0; index < MAX_INCLUDE_DEPTH - 1; index += 1) {
        const nextInclude =
          index === MAX_INCLUDE_DEPTH - 2 ? "./shared.json5" : `./chain-${index + 1}.json5`;
        await write(`config/chain-${index}.json5`, { $include: nextInclude });
      }
      const includePaths = await scan(configDir, {
        $include: ["./chain-0.json5", "./shared.json5"],
      });

      expect(includePaths).toContain(await fs.realpath(at("config/leaf.json5")));
    },
  ),
);

it("supports per-client agent includes", () => {
  const a = { id: "a", workspace: "~/a" };
  const b = { id: "b", workspace: "~/b" };
  const c = { id: "c", workspace: "~/c" };
  const files = {
    [configPath("clients", "a.json")]: { agents: [a, b], broadcast: { first: ["a", "b"] } },
    [configPath("clients", "b.json")]: { agents: [c], broadcast: { second: ["c"] } },
  };
  const config = { gateway: { port: 18789 }, $include: ["./clients/a.json", "./clients/b.json"] };
  expect(resolve(config, files)).toEqual({
    gateway: { port: 18789 },
    agents: [a, b, c],
    broadcast: { first: ["a", "b"], second: ["c"] },
  });
});

it("blocks prototype pollution vectors in included and sibling config", () => {
  const includePath = configPath("pollution.json");
  const included = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"hidden":true},"normal":3}',
  ) as Record<string, unknown>;
  const sibling: Record<string, unknown> = JSON.parse(
    '{"__proto__":{"alsoPolluted":true},"safe":1}',
  );

  const result = resolve({ $include: "./pollution.json", ...sibling }, { [includePath]: included });

  expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  expect((Object.prototype as Record<string, unknown>).alsoPolluted).toBeUndefined();
  expect(result).toEqual({ normal: 3, safe: 1 });
});

it("fails closed when include realpath resolution fails for reasons other than ENOENT", () => {
  const includePath = configPath("denied.json");
  const originalRealpathSync = nodeFs.realpathSync;
  const realpathSpy = vi.spyOn(nodeFs, "realpathSync").mockImplementation((target) => {
    if (path.normalize(String(target)) === includePath) {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return originalRealpathSync(target);
  });

  try {
    expectIncludeError(
      () => resolve({ $include: "./denied.json" }, { [includePath]: { leaked: true } }),
      /Failed to resolve include file realpath/,
    );
  } finally {
    realpathSpy.mockRestore();
  }
});

it(
  "rejects include files that are hardlinked aliases",
  withFiles(
    { "outside/secret.json5": { logging: { redactSensitive: "tools" } } },
    async ({ at, configDir }) => {
      if (process.platform === "win32") {
        return;
      }
      try {
        await fs.link(at("outside/secret.json5"), at("config/extra.json5"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          return;
        }
        throw err;
      }

      expect(() =>
        resolveIncludes({ $include: "./extra.json5" }, path.join(configDir, "openclaw.json")),
      ).toThrow(/security checks|hardlink/i);
    },
  ),
);

it(
  "rejects include files larger than the guarded read limit",
  withFiles(
    { "config/big.json5": { blob: "a".repeat(2 * 1024 * 1024 + 1) } },
    async ({ configDir }) => {
      expect(() =>
        resolveIncludes({ $include: "./big.json5" }, path.join(configDir, "openclaw.json")),
      ).toThrow(/security checks|max/i);
    },
  ),
);

it(
  "rejects a symlinked include that escapes both the config directory and every allowed root",
  withFiles({ "off-limits/secret.json5": { leaked: true } }, async ({ at, configDir }) => {
    await fs.mkdir(at("allowed"));
    try {
      await fs.symlink(
        at("off-limits/secret.json5"),
        at("config/secret.json5"),
        process.platform === "win32" ? "file" : undefined,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw err;
    }

    expect(() =>
      resolveIncludes(
        { $include: "./secret.json5" },
        path.join(configDir, "openclaw.json"),
        undefined,
        { allowedRoots: [at("allowed")] },
      ),
    ).toThrow(/resolves outside config directory/);
  }),
);
