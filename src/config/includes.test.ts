// Covers config include scanning and include-file merge behavior.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { collectIncludePathsRecursive } from "./includes-scan.js";
import {
  CircularIncludeError,
  ConfigIncludeError,
  MAX_INCLUDE_DEPTH,
  type ConfigIncludeResolutionEvent,
  type IncludeResolver,
  resolveConfigIncludeWritePath,
  resolveConfigIncludes,
} from "./includes.js";

const ROOT_DIR = path.parse(process.cwd()).root;
const CONFIG_DIR = path.join(ROOT_DIR, "config");
const ETC_OPENCLAW_DIR = path.join(ROOT_DIR, "etc", "openclaw");
const SHARED_DIR = path.join(ROOT_DIR, "shared");

const DEFAULT_BASE_PATH = path.join(CONFIG_DIR, "openclaw.json");

function configPath(...parts: string[]) {
  return path.join(CONFIG_DIR, ...parts);
}

function etcOpenClawPath(...parts: string[]) {
  return path.join(ETC_OPENCLAW_DIR, ...parts);
}

function sharedPath(...parts: string[]) {
  return path.join(SHARED_DIR, ...parts);
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

function resolve(obj: unknown, files: Record<string, unknown> = {}, basePath = DEFAULT_BASE_PATH) {
  return resolveConfigIncludes(obj, basePath, createMockResolver(files));
}

function expectResolveIncludeError(
  run: () => unknown,
  expectedPattern?: RegExp,
): ConfigIncludeError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigIncludeError);
  if (expectedPattern) {
    expect((thrown as Error).message).toMatch(expectedPattern);
  }
  return thrown as ConfigIncludeError;
}

describe("resolveConfigIncludes", () => {
  it("deep-merges overlapping keys from include arrays", () => {
    const files = {
      [configPath("a.json")]: { agents: { defaults: { workspace: "~/a" } } },
      [configPath("b.json")]: { agents: { list: [{ id: "main" }] } },
    };
    expect(resolve({ $include: ["./a.json", "./b.json"] }, files)).toEqual({
      agents: { defaults: { workspace: "~/a" }, list: [{ id: "main" }] },
    });
  });

  it("rejects sibling keys beside an array-valued include", () => {
    const files = { [configPath("list.json")]: ["a", "b"] };
    expectResolveIncludeError(
      () => resolve({ $include: "./list.json", extra: true }, files),
      /Sibling keys require included content to be an object/,
    );
  });

  it("reports exact include ownership through arrays, nesting, and sibling overrides", () => {
    const files = {
      [configPath("first.json")]: { id: "first" },
      [configPath("second.json")]: { enabled: true },
      [configPath("third.json")]: { mode: "strict" },
    };
    const events: ConfigIncludeResolutionEvent[] = [];
    const resolver = createMockResolver(files);
    resolver.onIncludeResolved = (event) => events.push(event);

    expect(
      resolveConfigIncludes(
        {
          plugins: [
            { $include: "./first.json" },
            {
              policy: {
                $include: ["./second.json", "./third.json"],
                enabled: false,
              },
            },
          ],
        },
        DEFAULT_BASE_PATH,
        resolver,
      ),
    ).toEqual({
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
    const events: ConfigIncludeResolutionEvent[] = [];
    const resolver = createMockResolver(files);
    resolver.onIncludeResolved = (event) => events.push(event);

    expect(
      resolveConfigIncludes(
        {
          agents: { $include: ["./delegating.json", "./override.json"] },
        },
        DEFAULT_BASE_PATH,
        resolver,
      ),
    ).toEqual({ agents: { mode: "override" } });
    expect(
      events.map(({ path: logicalPath, kind, targetPath, targetPaths }) => ({
        path: logicalPath,
        kind,
        targetPath,
        targetPaths,
      })),
    ).toEqual([
      {
        path: ["agents"],
        kind: "single",
        targetPath: configPath("nested.json"),
        targetPaths: undefined,
      },
      {
        path: ["agents"],
        kind: "multiple",
        targetPath: undefined,
        targetPaths: [configPath("delegating.json"), configPath("override.json")],
      },
    ]);
  });

  it.each([
    {
      name: "read failures",
      run: () => resolve({ $include: "./missing.json" }),
      pattern: /Failed to read include file/,
    },
    {
      name: "parse failures",
      run: () =>
        resolveConfigIncludes({ $include: "./bad.json" }, DEFAULT_BASE_PATH, {
          readFile: () => "{ invalid json }",
          parseJson: JSON.parse,
        }),
      pattern: /Failed to parse include file/,
    },
  ] as const)("surfaces include $name", ({ run, pattern }) => {
    expectResolveIncludeError(run, pattern);
  });

  it("throws CircularIncludeError for circular includes", () => {
    const aPath = configPath("a.json");
    const bPath = configPath("b.json");
    const resolver: IncludeResolver = {
      readFile: (filePath: string) => {
        if (filePath === aPath) {
          return JSON.stringify({ $include: "./b.json" });
        }
        if (filePath === bPath) {
          return JSON.stringify({ $include: "./a.json" });
        }
        throw new Error(`Unknown file: ${filePath}`);
      },
      parseJson: JSON.parse,
    };
    const obj = { $include: "./a.json" };
    try {
      resolveConfigIncludes(obj, DEFAULT_BASE_PATH, resolver);
      throw new Error("expected circular include error");
    } catch (err) {
      expect(err).toBeInstanceOf(CircularIncludeError);
      const circular = err as CircularIncludeError;
      expect(circular.chain).toContain(DEFAULT_BASE_PATH);
      expect(circular.chain).toContain(aPath);
      expect(circular.chain).toContain(bPath);
      expect(circular.message).toMatch(/Circular include detected/);
      expect(circular.message).toContain("a.json");
      expect(circular.message).toContain("b.json");
    }
  });

  it.each([
    {
      name: "rejects scalar include value",
      obj: { $include: 123 },
      expectedPattern: /expected string or array/,
    },
    {
      name: "rejects number in include array",
      obj: { $include: ["./valid.json", 123] },
      expectedPattern: /expected string, got number/,
    },
  ] as const)("throws on invalid include value/item types: $name", ({ obj, expectedPattern }) => {
    const files = { [configPath("valid.json")]: { valid: true } };
    expectResolveIncludeError(() => resolve(obj, files), expectedPattern);
  });

  it("allows depth 10 but rejects depth 11", () => {
    const okFiles: Record<string, unknown> = {};
    for (let i = 0; i < 9; i++) {
      okFiles[configPath(`ok${i}.json`)] = { $include: `./ok${i + 1}.json` };
    }
    okFiles[configPath("ok9.json")] = { done: true };
    expect(resolve({ $include: "./ok0.json" }, okFiles)).toEqual({
      done: true,
    });

    const failFiles: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      failFiles[configPath(`fail${i}.json`)] = {
        $include: `./fail${i + 1}.json`,
      };
    }
    failFiles[configPath("fail10.json")] = { done: true };
    expectResolveIncludeError(
      () => resolve({ $include: "./fail0.json" }, failFiles),
      /Maximum include depth/,
    );
  });

  it.each([
    {
      name: "resolves nested relative file path",
      files: {
        [configPath("clients", "mueller", "agents.json")]: { id: "mueller" },
      },
      obj: { agent: { $include: "./clients/mueller/agents.json" } },
      expected: {
        agent: { id: "mueller" },
      },
    },
    {
      name: "preserves nested override ordering",
      files: {
        [configPath("base.json")]: { nested: { $include: "./nested.json" } },
        [configPath("nested.json")]: { a: 1, b: 2 },
      },
      obj: { $include: "./base.json", nested: { b: 9 } },
      expected: {
        nested: { a: 1, b: 9 },
      },
    },
  ] as const)(
    "handles relative paths and nested include ordering: $name",
    ({ obj, files, expected }) => {
      expect(resolve(obj, files)).toEqual(expected);
    },
  );

  it("enforces traversal boundaries while allowing safe nested-parent paths", () => {
    expectResolveIncludeError(
      () =>
        resolve(
          { $include: "../../shared/common.json" },
          { [sharedPath("common.json")]: { shared: true } },
          configPath("sub", "openclaw.json"),
        ),
      /escapes config directory/,
    );

    expect(
      resolve(
        { $include: "./sub/child.json" },
        {
          [configPath("sub", "child.json")]: { $include: "../shared/common.json" },
          [configPath("shared", "common.json")]: { shared: true },
        },
      ),
    ).toEqual({
      shared: true,
    });
  });
});

describe("collectIncludePathsRecursive", () => {
  it.runIf(process.platform !== "win32")(
    "only reports includes the production resolver can safely open",
    async () => {
      await withTestDir({ prefix: "openclaw-include-scan-" }, async (tempRoot) => {
        const configDir = path.join(tempRoot, "config");
        const safeIncludePath = path.join(configDir, "safe.json5");
        const outsideIncludePath = path.join(tempRoot, "outside.json5");
        const symlinkPath = path.join(configDir, "outside-link.json5");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(safeIncludePath, "{ safe: true }\n", "utf-8");
        await fs.writeFile(outsideIncludePath, "{ outside: true }\n", "utf-8");
        await fs.symlink(outsideIncludePath, symlinkPath);

        const includePaths = await collectIncludePathsRecursive({
          configPath: path.join(configDir, "openclaw.json"),
          parsed: {
            $include: ["./safe.json5", "../outside.json5", "./outside-link.json5"],
          },
        });

        expect(includePaths).toEqual([await fs.realpath(safeIncludePath)]);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps the original root boundary after a parent symlink swap",
    async () => {
      await withTestDir({ prefix: "openclaw-include-root-swap-" }, async (tempRoot) => {
        const trustedDir = path.join(tempRoot, "trusted");
        const outsideDir = path.join(tempRoot, "outside");
        const configLink = path.join(tempRoot, "config-link");
        await fs.mkdir(trustedDir, { recursive: true });
        await fs.mkdir(outsideDir, { recursive: true });
        await fs.writeFile(
          path.join(trustedDir, "outer.json5"),
          '{ "$include": "./nested.json5" }\n',
          "utf-8",
        );
        await fs.writeFile(path.join(trustedDir, "nested.json5"), "{ trusted: true }\n", "utf-8");
        await fs.writeFile(path.join(outsideDir, "nested.json5"), "{ escaped: true }\n", "utf-8");
        await fs.symlink(trustedDir, configLink);

        let swapped = false;
        const resolver: IncludeResolver = {
          readFile: (filePath) => nodeFs.readFileSync(filePath, "utf-8"),
          parseJson: (raw) => {
            const parsed = JSON.parse(raw) as unknown;
            if (!swapped) {
              nodeFs.unlinkSync(configLink);
              nodeFs.symlinkSync(outsideDir, configLink);
              swapped = true;
            }
            return parsed;
          },
        };

        expect(() =>
          resolveConfigIncludes(
            { $include: "./outer.json5" },
            path.join(configLink, "openclaw.json"),
            resolver,
          ),
        ).toThrow(/resolves outside config directory/);
      });
    },
  );

  it("honors explicitly allowed include roots", async () => {
    await withTestDir({ prefix: "openclaw-include-scan-roots-" }, async (tempRoot) => {
      const configDir = path.join(tempRoot, "config");
      const sharedDir = path.join(tempRoot, "shared");
      const sharedIncludePath = path.join(sharedDir, "shared.json5");
      await fs.mkdir(configDir, { recursive: true });
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.writeFile(sharedIncludePath, "{ shared: true }\n", "utf-8");

      const includePaths = await collectIncludePathsRecursive({
        configPath: path.join(configDir, "openclaw.json"),
        parsed: { $include: sharedIncludePath },
        allowedRoots: [sharedDir],
      });

      expect(includePaths).toEqual([await fs.realpath(sharedIncludePath)]);
    });
  });

  it("continues past rejected nested includes to later safe siblings", async () => {
    await withTestDir({ prefix: "openclaw-include-scan-nested-" }, async (tempRoot) => {
      const configDir = path.join(tempRoot, "config");
      const nestedDir = path.join(configDir, "nested");
      const outerIncludePath = path.join(nestedDir, "outer.json5");
      const safeIncludePath = path.join(configDir, "safe.json5");
      const escapedIncludePath = path.join(tempRoot, "escaped.json5");
      await fs.mkdir(nestedDir, { recursive: true });
      await fs.writeFile(
        outerIncludePath,
        '{ "$include": ["../../escaped.json5", "../safe.json5"] }\n',
        "utf-8",
      );
      await fs.writeFile(safeIncludePath, "{ safe: true }\n", "utf-8");
      await fs.writeFile(escapedIncludePath, "{ escaped: true }\n", "utf-8");

      const includePaths = await collectIncludePathsRecursive({
        configPath: path.join(configDir, "openclaw.json"),
        parsed: { $include: "./nested/outer.json5" },
      });

      expect(includePaths).toEqual([
        await fs.realpath(outerIncludePath),
        await fs.realpath(safeIncludePath),
      ]);
    });
  });

  it("revisits an include reached later at a shallower depth", async () => {
    await withTestDir({ prefix: "openclaw-include-scan-depth-" }, async (tempRoot) => {
      const configDir = path.join(tempRoot, "config");
      const sharedIncludePath = path.join(configDir, "shared.json5");
      const leafIncludePath = path.join(configDir, "leaf.json5");
      await fs.mkdir(configDir, { recursive: true });
      for (let index = 0; index < MAX_INCLUDE_DEPTH - 1; index += 1) {
        const nextInclude =
          index === MAX_INCLUDE_DEPTH - 2 ? "./shared.json5" : `./chain-${index + 1}.json5`;
        await fs.writeFile(
          path.join(configDir, `chain-${index}.json5`),
          `{ "$include": ${JSON.stringify(nextInclude)} }\n`,
          "utf-8",
        );
      }
      await fs.writeFile(sharedIncludePath, '{ "$include": "./leaf.json5" }\n', "utf-8");
      await fs.writeFile(leafIncludePath, "{ leaf: true }\n", "utf-8");

      const includePaths = await collectIncludePathsRecursive({
        configPath: path.join(configDir, "openclaw.json"),
        parsed: { $include: ["./chain-0.json5", "./shared.json5"] },
      });

      expect(includePaths).toContain(await fs.realpath(leafIncludePath));
    });
  });
});

describe("resolveConfigIncludeWritePath", () => {
  it.runIf(process.platform !== "win32")(
    "canonicalizes missing targets through symlinks into allowed roots",
    async () => {
      await withTestDir({ prefix: "openclaw-include-write-path-" }, async (tempRoot) => {
        const configDir = path.join(tempRoot, "config");
        const allowedDir = path.join(tempRoot, "allowed");
        const linkDir = path.join(configDir, "shared");
        await fs.mkdir(configDir, { recursive: true });
        await fs.mkdir(allowedDir, { recursive: true });
        await fs.symlink(allowedDir, linkDir);
        const allowedRealDir = await fs.realpath(allowedDir);

        expect(
          resolveConfigIncludeWritePath({
            configPath: path.join(configDir, "openclaw.json"),
            includePath: path.join(linkDir, "plugins.json5"),
            allowedRoots: [allowedDir],
          }),
        ).toBe(path.join(allowedRealDir, "plugins.json5"));
      });
    },
  );
});

describe("real-world config patterns", () => {
  it.each([
    {
      name: "per-client agent includes",
      files: {
        [configPath("clients", "mueller.json")]: {
          agents: [
            {
              id: "mueller-screenshot",
              workspace: "~/clients/mueller/screenshot",
            },
            {
              id: "mueller-transcribe",
              workspace: "~/clients/mueller/transcribe",
            },
          ],
          broadcast: {
            "group-mueller": ["mueller-screenshot", "mueller-transcribe"],
          },
        },
        [configPath("clients", "schmidt.json")]: {
          agents: [
            {
              id: "schmidt-screenshot",
              workspace: "~/clients/schmidt/screenshot",
            },
          ],
          broadcast: { "group-schmidt": ["schmidt-screenshot"] },
        },
      },
      obj: {
        gateway: { port: 18789 },
        $include: ["./clients/mueller.json", "./clients/schmidt.json"],
      },
      expected: {
        gateway: { port: 18789 },
        agents: [
          { id: "mueller-screenshot", workspace: "~/clients/mueller/screenshot" },
          { id: "mueller-transcribe", workspace: "~/clients/mueller/transcribe" },
          { id: "schmidt-screenshot", workspace: "~/clients/schmidt/screenshot" },
        ],
        broadcast: {
          "group-mueller": ["mueller-screenshot", "mueller-transcribe"],
          "group-schmidt": ["schmidt-screenshot"],
        },
      },
    },
  ] as const)("supports common modular include layouts: $name", ({ obj, files, expected }) => {
    expect(resolve(obj, files)).toEqual(expected);
  });
});
describe("security: path traversal protection (CWE-22)", () => {
  it("allows same-directory includes without a ./ prefix", () => {
    expect(
      resolve({ $include: "sub.json" }, { [configPath("sub.json")]: { key: "value" } }),
    ).toEqual({
      key: "value",
    });
  });

  describe("error properties", () => {
    it.each([
      {
        includePath: "/etc/passwd",
        expectedMessageIncludes: ["escapes config directory", "/etc/passwd"],
      },
      {
        includePath: "../../etc/passwd",
        expectedMessageIncludes: ["escapes config directory", "../../etc/passwd"],
      },
    ] as const)(
      "preserves error type/path/message details for $includePath",
      ({ includePath, expectedMessageIncludes }) => {
        const obj = { $include: includePath };
        try {
          resolve(obj, {});
          expect.fail("Should have thrown");
        } catch (err) {
          expect(err, includePath).toBeInstanceOf(ConfigIncludeError);
          expect(err, includePath).toHaveProperty("name", "ConfigIncludeError");
          expect((err as ConfigIncludeError).includePath, includePath).toBe(includePath);
          for (const messagePart of expectedMessageIncludes) {
            expect((err as Error).message, `${includePath}: ${messagePart}`).toContain(messagePart);
          }
        }
      },
    );
  });

  it("rejects a malicious path after a legitimate array include", () => {
    const files = { [configPath("good.json")]: { good: true } };
    expect(() => resolve({ $include: ["./good.json", "/etc/passwd"] }, files)).toThrow(
      ConfigIncludeError,
    );
  });

  describe("prototype pollution protection", () => {
    it("blocks prototype pollution vectors in included and sibling config", () => {
      const includePath = configPath("pollution.json");
      const included = JSON.parse(
        '{"__proto__":{"polluted":true},"constructor":{"hidden":true},"normal":3}',
      ) as Record<string, unknown>;
      const sibling = JSON.parse('{"__proto__":{"alsoPolluted":true},"safe":1}') as Record<
        string,
        unknown
      >;

      const result = resolve(
        { $include: "./pollution.json", ...sibling },
        { [includePath]: included },
      );

      expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
      expect((Object.prototype as Record<string, unknown>).alsoPolluted).toBeUndefined();
      expect(result).toEqual({ normal: 3, safe: 1 });
    });
  });

  describe("edge cases", () => {
    it("rejects malformed include paths", () => {
      const cases = [
        { includePath: "./file\x00.json", pattern: /null bytes?/i },
        { includePath: "//etc/passwd", pattern: /escapes config directory/ },
      ] as const;
      for (const testCase of cases) {
        const obj = { $include: testCase.includePath };
        expectResolveIncludeError(() => resolve(obj, {}), testCase.pattern);
      }
    });

    it("rejects include paths at or over the platform-safe maximum", () => {
      expectResolveIncludeError(
        () => resolve({ $include: "a".repeat(4096) }, {}),
        /maximum length/,
      );
    });

    it("allows child include when config is at filesystem root", () => {
      const rootConfigPath = path.join(path.parse(process.cwd()).root, "test.json");
      const childPath = path.join(path.parse(process.cwd()).root, "child.json");
      const files = { [childPath]: { root: true } };
      const obj = { $include: childPath };
      expect(resolve(obj, files, rootConfigPath)).toEqual({ root: true });
    });

    it("allows include files when the config root path is a symlink", async () => {
      await withTestDir({ prefix: "openclaw-includes-symlink-" }, async (tempRoot) => {
        const realRoot = path.join(tempRoot, "real");
        const linkRoot = path.join(tempRoot, "link");
        await fs.mkdir(path.join(realRoot, "includes"), { recursive: true });
        await fs.writeFile(
          path.join(realRoot, "includes", "extra.json5"),
          "{ logging: { redactSensitive: 'tools' } }\n",
          "utf-8",
        );
        await fs.symlink(realRoot, linkRoot, process.platform === "win32" ? "junction" : undefined);

        const result = resolveConfigIncludes(
          { $include: "./includes/extra.json5" },
          path.join(linkRoot, "openclaw.json"),
        );
        expect(result).toEqual({ logging: { redactSensitive: "tools" } });
      });
    });

    it("fails closed when include realpath resolution fails for reasons other than ENOENT", () => {
      const includePath = configPath("denied.json");
      const originalRealpathSync = nodeFs.realpathSync;
      const realpathSpy = vi.spyOn(nodeFs, "realpathSync").mockImplementation((target) => {
        if (path.normalize(String(target)) === includePath) {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return originalRealpathSync(target);
      });

      try {
        expectResolveIncludeError(
          () =>
            resolveConfigIncludes(
              { $include: "./denied.json" },
              DEFAULT_BASE_PATH,
              createMockResolver({ [includePath]: { leaked: true } }),
            ),
          /Failed to resolve include file realpath/,
        );
      } finally {
        realpathSpy.mockRestore();
      }
    });

    it("rejects include files that are hardlinked aliases", async () => {
      if (process.platform === "win32") {
        return;
      }
      await withTestDir({ prefix: "openclaw-includes-hardlink-" }, async (tempRoot) => {
        const configDir = path.join(tempRoot, "config");
        const outsideDir = path.join(tempRoot, "outside");
        await fs.mkdir(configDir, { recursive: true });
        await fs.mkdir(outsideDir, { recursive: true });
        const includePath = path.join(configDir, "extra.json5");
        const outsidePath = path.join(outsideDir, "secret.json5");
        await fs.writeFile(outsidePath, '{"logging":{"redactSensitive":"tools"}}\n', "utf-8");
        try {
          await fs.link(outsidePath, includePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EXDEV") {
            return;
          }
          throw err;
        }

        expect(() =>
          resolveConfigIncludes(
            { $include: "./extra.json5" },
            path.join(configDir, "openclaw.json"),
          ),
        ).toThrow(/security checks|hardlink/i);
      });
    });

    it("rejects include files larger than the guarded read limit", async () => {
      await withTestDir({ prefix: "openclaw-includes-big-" }, async (tempRoot) => {
        const configDir = path.join(tempRoot, "config");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "big.json5"),
          `{"blob":"${"a".repeat(2 * 1024 * 1024 + 1)}"}`,
          "utf-8",
        );

        expect(() =>
          resolveConfigIncludes({ $include: "./big.json5" }, path.join(configDir, "openclaw.json")),
        ).toThrow(/security checks|max/i);
      });
    });
  });
});

describe("OPENCLAW_INCLUDE_ROOTS allowlist", () => {
  it("still rejects include paths that fall outside every allowed root", () => {
    const obj = { $include: etcOpenClawPath("agents.json") };
    expect(() =>
      resolveConfigIncludes(obj, DEFAULT_BASE_PATH, createMockResolver({}), {
        allowedRoots: [SHARED_DIR],
      }),
    ).toThrow(/escapes config directory/);
  });

  it("preserves the config-directory boundary when allowedRoots is empty", () => {
    expect(() =>
      resolveConfigIncludes(
        { $include: sharedPath("common.json") },
        DEFAULT_BASE_PATH,
        createMockResolver({}),
        { allowedRoots: [] },
      ),
    ).toThrow(/escapes config directory/);
  });

  it("ignores non-absolute or empty allowedRoots entries while honoring valid ones", () => {
    const sharedFile = sharedPath("common.json");
    const files = { [sharedFile]: { shared: true } };
    expect(
      resolveConfigIncludes(
        { $include: sharedFile },
        DEFAULT_BASE_PATH,
        createMockResolver(files),
        { allowedRoots: ["", "./relative", SHARED_DIR] },
      ),
    ).toEqual({ shared: true });
  });

  it("resolves a symlinked include whose realpath lands inside an allowed root", async () => {
    await withTestDir({ prefix: "openclaw-includes-allowed-symlink-" }, async (tempRoot) => {
      const configDir = path.join(tempRoot, "config");
      const sharedDir = path.join(tempRoot, "shared");
      await fs.mkdir(configDir, { recursive: true });
      await fs.mkdir(sharedDir, { recursive: true });
      const sharedTarget = path.join(sharedDir, "extra.json5");
      await fs.writeFile(sharedTarget, "{ logging: { redactSensitive: 'tools' } }\n", "utf-8");
      const linkInConfig = path.join(configDir, "extra.json5");
      await fs.symlink(
        sharedTarget,
        linkInConfig,
        process.platform === "win32" ? "file" : undefined,
      );

      const result = resolveConfigIncludes(
        { $include: "./extra.json5" },
        path.join(configDir, "openclaw.json"),
        undefined,
        { allowedRoots: [sharedDir] },
      );
      expect(result).toEqual({ logging: { redactSensitive: "tools" } });
    });
  });

  it("rejects a symlinked include that escapes both the config directory and every allowed root", async () => {
    await withTestDir({ prefix: "openclaw-includes-allowed-escape-" }, async (tempRoot) => {
      const configDir = path.join(tempRoot, "config");
      const allowedDir = path.join(tempRoot, "allowed");
      const offRootDir = path.join(tempRoot, "off-limits");
      await fs.mkdir(configDir, { recursive: true });
      await fs.mkdir(allowedDir, { recursive: true });
      await fs.mkdir(offRootDir, { recursive: true });
      const offRootTarget = path.join(offRootDir, "secret.json5");
      await fs.writeFile(offRootTarget, "{ leaked: true }\n", "utf-8");
      const linkInConfig = path.join(configDir, "secret.json5");
      try {
        await fs.symlink(
          offRootTarget,
          linkInConfig,
          process.platform === "win32" ? "file" : undefined,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") {
          return;
        }
        throw err;
      }

      expect(() =>
        resolveConfigIncludes(
          { $include: "./secret.json5" },
          path.join(configDir, "openclaw.json"),
          undefined,
          { allowedRoots: [allowedDir] },
        ),
      ).toThrow(/resolves outside config directory/);
    });
  });
});
