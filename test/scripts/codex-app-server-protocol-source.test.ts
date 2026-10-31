import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { stageCodexAppServerProtocolArtifacts } from "../../scripts/lib/codex-app-server-protocol-artifacts.js";
import {
  buildCodexProtocolFixtureCommand,
  canonicalizeCodexAppServerProtocolJson,
  codexAppServerSharedDefinitionsSchema,
  compactCodexAppServerProtocolJsonSchemas,
  expandCodexAppServerProtocolJsonSchema,
  formatCodexAppServerProtocolJsonText,
  materializeCodexProtocolPrecomputedExports,
  readCargoWorkspacePackageVersion,
  resolveCodexAppServerProtocolSource,
  resolveCodexProtocolCargoTargetDir,
  resolveCodexProtocolMinFreeBytes,
  selectedCodexAppServerJsonSchemas,
  validateCodexProtocolSourceVersion,
  validateCodexProtocolGenerationHeadroom,
} from "../../scripts/lib/codex-app-server-protocol-source.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const originalOpenClawCodexRepo = process.env.OPENCLAW_CODEX_REPO;
const schemaFixture = () =>
  new Map<string, unknown>(selectedCodexAppServerJsonSchemas.map((title) => [title, { title }]));
const checkHeadroom = (freeBytes: number, minFreeBytes: number) =>
  validateCodexProtocolGenerationHeadroom({ freeBytes, minFreeBytes, pathLabel: "/repo" });

afterEach(() => {
  if (originalOpenClawCodexRepo === undefined) {
    delete process.env.OPENCLAW_CODEX_REPO;
  } else {
    process.env.OPENCLAW_CODEX_REPO = originalOpenClawCodexRepo;
  }
});

function versionFixture(version: string, cargoVersion = version) {
  const repoRoot = createTempDir("openclaw-protocol-version-root-");
  const codexRepo = createTempDir("openclaw-protocol-version-codex-");
  fs.mkdirSync(path.join(repoRoot, "extensions/codex"), { recursive: true });
  fs.mkdirSync(path.join(codexRepo, "codex-rs"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "extensions/codex/package.json"),
    JSON.stringify({ dependencies: { "@openai/codex": version } }),
  );
  fs.writeFileSync(
    path.join(codexRepo, "codex-rs/Cargo.toml"),
    `[workspace.package]\nversion = "${cargoVersion}"\n`,
  );
  return { codexRepo, repoRoot };
}

describe("Codex app-server generated artifact staging", () => {
  it("copies JSON bytes and normalizes nested TypeScript files in one pass", async () => {
    const sourceRoot = createTempDir("openclaw-protocol-artifacts-source-");
    const targetRoot = createTempDir("openclaw-protocol-artifacts-target-");
    const typescriptRoot = path.join(targetRoot, "typescript");
    const jsonRoot = path.join(targetRoot, "json");
    const rootTypeScript = `import type { Root } from "./Root";
export type { Parent } from '../Parent.js';
export * as v2 from "./v2.js";
export type Nullable = string | null | null;
`;
    const nestedTypeScript = 'export type { Shared } from "../Shared";\n';
    const json = '{\n  "z": 1,\n  "a": 2\n}\n';
    fs.mkdirSync(path.join(sourceRoot, "v2"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "index.ts"), rootTypeScript);
    fs.writeFileSync(path.join(sourceRoot, "v2/Thing.ts"), nestedTypeScript);
    fs.writeFileSync(path.join(sourceRoot, "v2/Thing.json"), json);
    fs.writeFileSync(path.join(sourceRoot, "README.md"), "ignored\n");

    await stageCodexAppServerProtocolArtifacts(sourceRoot, { jsonRoot, typescriptRoot });

    expect(fs.readFileSync(path.join(typescriptRoot, "index.ts"), "utf8")).toBe(
      `import type { Root } from "./Root.js";
export type { Parent } from '../Parent.js';
export * as v2 from "./v2/index.js";
export type Nullable = string | null;
`,
    );
    expect(fs.readFileSync(path.join(typescriptRoot, "v2/Thing.ts"), "utf8")).toBe(
      'export type { Shared } from "../Shared.js";\n',
    );
    expect(fs.readFileSync(path.join(jsonRoot, "v2/Thing.json"), "utf8")).toBe(json);
    expect(fs.existsSync(path.join(typescriptRoot, "README.md"))).toBe(false);
    expect(fs.existsSync(path.join(jsonRoot, "README.md"))).toBe(false);
    expect(fs.readFileSync(path.join(sourceRoot, "index.ts"), "utf8")).toBe(rootTypeScript);
  });

  it("materializes the upstream experimental precomputed export tree", async () => {
    const root = createTempDir("openclaw-protocol-precomputed-");
    const archivePath = path.join(root, "precomputed/app-server-exports-experimental.json.zst");
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(
      archivePath,
      zstdCompressSync(
        JSON.stringify({
          typescript: { "v2/Thing.ts": "export type Thing = string;\n" },
          json_schema: { "v2/Thing.json": '{"type":"string"}\n' },
          internal_json_schema: {},
        }),
      ),
    );

    await materializeCodexProtocolPrecomputedExports(root);

    expect(fs.readFileSync(path.join(root, "v2/Thing.ts"), "utf8")).toBe(
      "export type Thing = string;\n",
    );
    expect(fs.readFileSync(path.join(root, "v2/Thing.json"), "utf8")).toBe('{"type":"string"}\n');
    expect(fs.existsSync(archivePath)).toBe(false);
  });
});

describe("codex app-server protocol source resolver", () => {
  it("reads the Cargo workspace package version without matching sibling sections", () => {
    expect(
      readCargoWorkspacePackageVersion(`
[workspace]
members = []

[workspace.package] # shared crate metadata
version = "0.142.5"
edition = "2024"

[workspace.dependencies]
version = "9.9.9"
`),
    ).toBe("0.142.5");
    expect(readCargoWorkspacePackageVersion('[workspace.dependencies]\nversion = "9.9.9"\n')).toBe(
      undefined,
    );
  });

  it("rejects a Codex checkout that differs from the pinned package version", async () => {
    await expect(
      validateCodexProtocolSourceVersion(versionFixture("0.142.5", "0.142.4")),
    ).rejects.toThrow(/0\.142\.4 does not match @openai\/codex 0\.142\.5/);
  });

  it("requires a Git repository, exact-version tag, and matching tagged commit", async () => {
    const { repoRoot, codexRepo } = versionFixture("0.149.0");
    await expect(validateCodexProtocolSourceVersion({ codexRepo, repoRoot })).rejects.toThrow(
      /Could not resolve Codex protocol source HEAD/,
    );

    for (const args of [
      ["init"],
      ["config", "user.name", "OpenClaw Test"],
      ["config", "user.email", "test@example.invalid"],
      ["add", "codex-rs/Cargo.toml"],
      ["commit", "-m", "tagged source"],
    ]) {
      expect(spawnSync("git", args, { cwd: codexRepo }).status).toBe(0);
    }
    await expect(validateCodexProtocolSourceVersion({ codexRepo, repoRoot })).rejects.toThrow(
      /Could not resolve Codex protocol source refs\/tags\/rust-v0\.149\.0/,
    );

    expect(spawnSync("git", ["tag", "rust-v0.149.0"], { cwd: codexRepo }).status).toBe(0);
    await expect(
      validateCodexProtocolSourceVersion({ codexRepo, repoRoot }),
    ).resolves.toBeUndefined();

    fs.writeFileSync(path.join(codexRepo, "README.md"), "later commit\n");
    expect(spawnSync("git", ["add", "README.md"], { cwd: codexRepo }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-m", "later source"], { cwd: codexRepo }).status).toBe(0);
    await expect(validateCodexProtocolSourceVersion({ codexRepo, repoRoot })).rejects.toThrow(
      /does not match peeled rust-v0\.149\.0 commit/,
    );
  });

  it("uses the upstream ignored fixture test with explicit schema env", () => {
    expect(
      buildCodexProtocolFixtureCommand("/codex/codex-rs/Cargo.toml", "/tmp/protocol", {
        CARGO_TARGET_DIR: "/cache/codex-target",
      }),
    ).toEqual({
      args: (
        "test --manifest-path /codex/codex-rs/Cargo.toml -p codex-app-server-protocol " +
        "--lib schema_fixtures_tests::write_schema_fixtures_from_env -- --exact --ignored"
      ).split(" "),
      env: {
        CARGO_TARGET_DIR: "/cache/codex-target",
        CODEX_APP_SERVER_SCHEMA_ROOT: "/tmp/protocol",
        CODEX_APP_SERVER_SCHEMA_EXPERIMENTAL: "1",
      },
    });
  });

  it("fails before cargo protocol generation when local disk headroom is too low", () => {
    expect(() => checkHeadroom(6 * 1024 ** 3, 10 * 1024 ** 3)).toThrow(
      /Run this check on Crabbox\/Testbox/,
    );
  });

  it("allows an explicit local disk headroom override", () => {
    expect(resolveCodexProtocolMinFreeBytes({ OPENCLAW_CODEX_PROTOCOL_MIN_FREE_BYTES: "0" })).toBe(
      0,
    );
    expect(() => checkHeadroom(1, 0)).not.toThrow();
  });

  it("rejects malformed local disk headroom overrides", () => {
    expect(() =>
      resolveCodexProtocolMinFreeBytes({ OPENCLAW_CODEX_PROTOCOL_MIN_FREE_BYTES: "nope" }),
    ).toThrow(/non-negative byte count/);
  });

  it.each([
    [{}, path.join("/codex", "codex-rs", "target")],
    [{ CARGO_TARGET_DIR: "target-cache" }, path.join("/codex", "target-cache")],
    [{ CARGO_BUILD_TARGET_DIR: "/cache/build-target" }, path.resolve("/cache/build-target")],
  ] as const)("resolves Cargo target directory %j", (env, expected) => {
    expect(resolveCodexProtocolCargoTargetDir("/codex", env)).toBe(expected);
  });

  it("uses OPENCLAW_CODEX_REPO when provided", async () => {
    const root = createTempDir("openclaw-protocol-source-root-");
    const codexRepo = createTempDir("openclaw-protocol-source-codex-");
    createProtocolSchema(codexRepo);
    process.env.OPENCLAW_CODEX_REPO = codexRepo;

    await expect(resolveCodexAppServerProtocolSource(root)).resolves.toEqual({
      codexRepo,
      sourceRoot: path.join(codexRepo, "codex-rs/app-server-protocol/schema"),
    });
  });

  it("finds the primary checkout sibling from a git worktree", async () => {
    const parentDir = createTempDir("openclaw-protocol-source-parent-");
    const primaryOpenClaw = path.join(parentDir, "openclaw");
    const codexRepo = path.join(parentDir, "codex");
    const worktreeRoot = createTempDir("openclaw-protocol-source-worktree-");
    fs.mkdirSync(path.join(primaryOpenClaw, ".git", "worktrees", "codex-harness"), {
      recursive: true,
    });
    fs.mkdirSync(worktreeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(worktreeRoot, ".git"),
      `gitdir: ${path.join(primaryOpenClaw, ".git", "worktrees", "codex-harness")}\n`,
    );
    createProtocolSchema(codexRepo);
    delete process.env.OPENCLAW_CODEX_REPO;

    await expect(resolveCodexAppServerProtocolSource(worktreeRoot)).resolves.toEqual({
      codexRepo,
      sourceRoot: path.join(codexRepo, "codex-rs/app-server-protocol/schema"),
    });
  });
});

describe("Codex app-server protocol JSON canonicalizer", () => {
  it("sorts object keys recursively before formatting", () => {
    const source = JSON.stringify({
      z: { b: { z: 0, a: 1 }, a: 2 },
      a: [{ z: 0, a: 1 }],
      definitions: { Z: { z: 0, a: 1 }, A: { type: "string" } },
    });

    expect(formatCodexAppServerProtocolJsonText(source)).toBe(`{
  "a": [{"a":1,"z":0}],
  "definitions": {
    "A": {"type":"string"},
    "Z": {"a":1,"z":0}
  },
  "z": {"a":2,"b":{"a":1,"z":0}}
}
`);
  });

  it("sorts typed-object arrays only for order-insensitive schema keywords", () => {
    const values = [
      { type: "z", n: 1 },
      { type: "a", n: 2 },
      { type: "z", n: 3 },
    ];
    const sorted = [values[1], values[0], values[2]];
    const unchanged = {
      mixed: [values[0], "item", values[1]],
      prefixItems: values,
      typed: values,
    };
    expect(
      canonicalizeCodexAppServerProtocolJson(
        structuredClone({
          anyOf: values,
          enum: values,
          required: values,
          oneOf: values,
          ...unchanged,
        }),
      ),
    ).toEqual({
      anyOf: sorted,
      enum: sorted,
      required: sorted,
      oneOf: sorted,
      ...unchanged,
    });
  });

  it("factors repeated definitions and exactly reconstructs every source schema", () => {
    const schemas = schemaFixture();
    const shared = { properties: { value: { $ref: "#/definitions/Leaf" } }, type: "object" };
    const leaf = { type: "string" };
    schemas.set("DynamicToolCallParams.json", {
      definitions: { Leaf: leaf },
      $ref: "#/definitions/Leaf",
    });
    const definitions = { Leaf: leaf, Shared: shared };
    schemas.set("v2/ErrorNotification.json", {
      definitions,
      properties: { error: { $ref: "#/definitions/Shared" } },
    });
    schemas.set("v2/GetAccountResponse.json", { definitions, $ref: "#/definitions/Shared" });

    const compacted = compactCodexAppServerProtocolJsonSchemas(schemas);
    const sharedSchema = compacted.get(codexAppServerSharedDefinitionsSchema);
    expect(sharedSchema).toMatchObject({
      definitions: { Leaf: leaf, Shared: shared },
      title: "CodexAppServerProtocolDefinitions",
    });
    expect(compacted.get("v2/ErrorNotification.json")).toMatchObject({
      properties: {
        error: { $ref: "./CodexAppServerProtocolDefinitions.json#/definitions/Shared" },
      },
    });
    expect(compacted.get("DynamicToolCallParams.json")).toMatchObject({
      $ref: "./v2/CodexAppServerProtocolDefinitions.json#/definitions/Leaf",
    });

    for (const schemaPath of selectedCodexAppServerJsonSchemas) {
      expect(
        expandCodexAppServerProtocolJsonSchema({
          schema: compacted.get(schemaPath),
          schemaPath,
          sharedSchema,
        }),
      ).toEqual(canonicalizeCodexAppServerProtocolJson(schemas.get(schemaPath)));
    }
  });

  it("rejects same-name definitions with different schema semantics", () => {
    const schemas = schemaFixture();
    schemas.set("v2/ErrorNotification.json", {
      definitions: { Shared: { type: "string" } },
      $ref: "#/definitions/Shared",
    });
    schemas.set("v2/GetAccountResponse.json", {
      definitions: { Shared: { type: "integer" } },
      $ref: "#/definitions/Shared",
    });

    expect(() => compactCodexAppServerProtocolJsonSchemas(schemas)).toThrow(
      /shared definition Shared differs across schemas/,
    );
  });
});

function createProtocolSchema(codexRepo: string): void {
  fs.mkdirSync(path.join(codexRepo, "codex-rs/app-server-protocol/schema/typescript"), {
    recursive: true,
  });
}
