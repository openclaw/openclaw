import { describe, expect, it } from "vitest";
import {
  assertEnvironmentRecipeSecretsMapped,
  type EnvironmentRecipeEntry,
  EnvironmentRecipeSchema,
  resolveEnvironmentRecipe,
} from "./environment-recipe.js";

function entry(content = "", blob = "a".repeat(40), executable = false): EnvironmentRecipeEntry {
  return { blob, executable, content };
}

function resolve(files: Record<string, EnvironmentRecipeEntry>) {
  return resolveEnvironmentRecipe(async (file) => files[file]);
}

function devcontainer(content: string) {
  return resolve({ ".devcontainer.json": entry(content) });
}

describe("resolveEnvironmentRecipe", () => {
  it("prefers the nested JSONC devcontainer over the root file, script, and detection", async () => {
    const recipe = await resolve({
      ".devcontainer/devcontainer.json": entry(`{
        // This setup is captured.
        "onCreateCommand": "npm ci",
        "updateContentCommand": ["npm", "run", "build"],
        "postCreateCommand": {"index": "npm run index", "warm": ["npm", "run", "warm"]},
        "postStartCommand": "npm run start",
      }`),
      ".devcontainer.json": entry('{"onCreateCommand":"wrong"}'),
      ".openclaw/worktree-setup.sh": entry("#!/bin/sh\nexit 1", "b".repeat(40), true),
      "package-lock.json": entry(),
    });
    expect(recipe).toEqual({
      source: "devcontainer",
      identity: "a".repeat(40),
      inputs: { ".devcontainer/devcontainer.json": "a".repeat(40) },
      env: {},
      secretNames: [],
      onCreate: "npm ci",
      updateContent: ["npm", "run", "build"],
      postCreate: { index: "npm run index", warm: ["npm", "run", "warm"] },
      postStart: "npm run start",
    });
  });

  it.each([
    [
      "remote environment overrides container values",
      '{"containerEnv":{"MODE":"build","SHARED":"container"},"remoteEnv":{"SHARED":"remote"}}',
      { env: { MODE: "build", SHARED: "remote" } },
    ],
    [
      "ignored properties are reported without interpretation",
      '{"image":123,"features":false,"hostRequirements":null,"customizations":[],"name":"App"}',
      {
        ignoredPropertiesNote:
          "devcontainer customizations, features, hostRequirements, image ignored on cloud machines",
      },
    ],
    [
      "empty exec arguments and shell whitespace survive",
      '{"onCreateCommand":["printf","%s", ""],"postStartCommand":"  echo ready  "}',
      { onCreate: ["printf", "%s", ""], postStart: "  echo ready  " },
    ],
  ] as const)("accepts a root devcontainer: %s", async (_name, content, expected) => {
    const recipe = await devcontainer(content);
    expect(recipe).toMatchObject({
      source: "devcontainer",
      inputs: { ".devcontainer.json": "a".repeat(40) },
      ...expected,
    });
    if ("ignoredPropertiesNote" in expected) {
      expect(recipe.onCreate).toBeUndefined();
    }
  });

  it("allows remoteEnv null to unset inherited or container values", async () => {
    const recipe = await devcontainer(
      '{"containerEnv":{"MODE":"build"},"remoteEnv":{"MODE":null,"LANG":null}}',
    );
    expect(recipe.env).toEqual({ MODE: null, LANG: null });
    expect(EnvironmentRecipeSchema.parse(recipe).env).toEqual({ MODE: null, LANG: null });
  });

  it("resolves requested secret names without granting access from repository metadata", async () => {
    const recipe = await devcontainer(
      '{"secrets":{"TOKEN":{"description":"Package access","provider":"untrusted","id":"other"},"ACCOUNT":{}}}',
    );
    expect(recipe.secretNames).toEqual(["ACCOUNT", "TOKEN"]);
    expect(recipe.ignoredPropertiesNote).toBeUndefined();
    expect(EnvironmentRecipeSchema.parse(recipe).secretNames).toEqual(["ACCOUNT", "TOKEN"]);
    expect(() =>
      assertEnvironmentRecipeSecretsMapped(recipe, {
        TOKEN: { source: "store", provider: "default", id: "approved" },
      }),
    ).toThrow("unmapped setup secrets: ACCOUNT");
    expect(() =>
      assertEnvironmentRecipeSecretsMapped(recipe, { ACCOUNT: {}, TOKEN: {} }),
    ).not.toThrow();
    expect(() => assertEnvironmentRecipeSecretsMapped(recipe, undefined)).toThrow("ACCOUNT, TOKEN");
  });

  it("limits repository secret requests to sixteen names", async () => {
    const secrets = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`TOKEN_${index}`, {}]),
    );
    await expect(devcontainer(JSON.stringify({ secrets }))).rejects.toThrow(
      "At most 16 setup secrets",
    );
  });

  it("admits resolved lifecycle recipes and rejects malformed transport commands", async () => {
    const recipe = await devcontainer('{"onCreateCommand":["npm","ci"]}');
    expect(EnvironmentRecipeSchema.parse(recipe)).toEqual(recipe);
    expect(
      EnvironmentRecipeSchema.safeParse({ ...recipe, postStart: ["", "argument"] }).success,
    ).toBe(false);
    expect(EnvironmentRecipeSchema.safeParse({ ...recipe, identity: "not-a-blob" }).success).toBe(
      false,
    );
  });

  it.each([
    '{"onCreateCommand":42}',
    '{"secrets":{"BAD-NAME":{}}}',
    '{"secrets":{"TOKEN":"plaintext"}}',
    '{"secrets":["TOKEN"]}',
    '{"postStartCommand":{"bad":[1]}}',
    '{"remoteEnv":{"NUMBER":1}}',
    '{"remoteEnv":{"BAD-NAME":"value"}}',
    '{"remoteEnv":{"VALUE":"\\u0000"}}',
    '{"onCreateCommand":"\\u0000"}',
    '{"onCreateCommand":[]}',
    "[]",
  ])("rejects an invalid declared lifecycle recipe %s instead of falling back", async (content) => {
    await expect(
      resolve({ ".devcontainer.json": entry(content), "package-lock.json": entry() }),
    ).rejects.toThrow("Invalid cloud environment file .devcontainer.json");
  });

  it("rejects malformed JSONC instead of falling back", async () => {
    await expect(resolve({ ".devcontainer.json": entry("{broken") })).rejects.toThrow();
  });

  it("keeps the executable setup script's existing blob identity", async () => {
    expect(
      await resolve({
        ".openclaw/worktree-setup.sh": entry("#!/bin/sh", "b".repeat(40), true),
        "pnpm-lock.yaml": entry(),
      }),
    ).toEqual({
      source: "script",
      identity: "b".repeat(40),
      inputs: { ".openclaw/worktree-setup.sh": "b".repeat(40) },
      env: {},
      onCreate: ["./.openclaw/worktree-setup.sh"],
    });
  });

  it("does no setup without a lockfile or executable declared recipe", async () => {
    expect(
      await resolve({ ".openclaw/worktree-setup.sh": entry(), "package.json": entry("{}") }),
    ).toEqual({ source: "none", inputs: {}, env: {} });
  });

  it("selects pnpm first and enables corepack without sudo in the worker home", async () => {
    const recipe = await resolve({ "pnpm-lock.yaml": entry(), "yarn.lock": entry() });
    expect(recipe.source).toBe("detected");
    expect(recipe.detectedInstall).toBe(
      'mkdir -p "$HOME/.local/bin" && corepack enable --install-directory "$HOME/.local/bin" && PATH="$HOME/.local/bin:$PATH" pnpm install --frozen-lockfile',
    );
    expect(recipe.inputs).toEqual({ "pnpm-lock.yaml": "a".repeat(40) });
  });

  it.each([
    [{ "package.json": entry('{"packageManager":"yarn@4.6.0"}') }, "--immutable"],
    [{ ".yarnrc.yml": entry("nodeLinker: node-modules") }, "--immutable"],
    [{ "package.json": entry('{"packageManager":"yarn@1.22.22"}') }, "--frozen-lockfile"],
    [{ "package.json": entry("malformed") }, "--frozen-lockfile"],
    [{}, "--frozen-lockfile"],
  ])(
    "enables user-writable Corepack shims for the detected yarn generation %#",
    async (files, flag) => {
      const recipe = await resolve({ "yarn.lock": entry(), ...files });
      expect(recipe.detectedInstall).toBe(
        `mkdir -p "$HOME/.local/bin" && corepack enable --install-directory "$HOME/.local/bin" && PATH="$HOME/.local/bin:$PATH" yarn install ${flag}`,
      );
      expect(recipe.env).toEqual({
        COREPACK_ENABLE_AUTO_PIN: "0",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      });
    },
  );

  it("selects npm ci for a package lock", async () => {
    expect((await resolve({ "package-lock.json": entry() })).detectedInstall).toEqual([
      "npm",
      "ci",
    ]);
  });

  it.each(["bun.lock", "bun.lockb"])(
    "gates %s installation on bun being available",
    async (file) => {
      expect((await resolve({ [file]: entry() })).detectedInstall).toBe(
        'if command -v bun >/dev/null 2>&1; then bun install --frozen-lockfile; else printf "%s\\n" "OpenClaw: bun install skipped because bun is not on PATH" >&2; fi',
      );
    },
  );

  it("changes detected identity with lockfile, package-manager, or yarn config blobs", async () => {
    const files = {
      "yarn.lock": entry(),
      "package.json": entry('{"packageManager":"yarn@4.6.0"}'),
      ".yarnrc.yml": entry("nodeLinker: node-modules"),
    };
    const original = await resolve(files);
    expect(original.identity).toMatch(/^[a-f0-9]{64}$/u);
    for (const file of Object.keys(files)) {
      const changed = await resolve({ ...files, [file]: entry("{}", "b".repeat(40)) });
      expect(changed.identity).not.toBe(original.identity);
    }
    expect(await resolve(files)).toEqual(original);
  });
});
