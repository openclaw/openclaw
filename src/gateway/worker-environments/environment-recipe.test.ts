import { describe, expect, it } from "vitest";
import {
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
      onCreate: "npm ci",
      updateContent: ["npm", "run", "build"],
      postCreate: { index: "npm run index", warm: ["npm", "run", "warm"] },
      postStart: "npm run start",
    });
  });

  it("accepts the root devcontainer and lets remoteEnv override containerEnv", async () => {
    expect(
      await resolve({
        ".devcontainer.json": entry(
          '{"containerEnv":{"MODE":"build","SHARED":"container"},"remoteEnv":{"SHARED":"remote"}}',
        ),
      }),
    ).toMatchObject({
      source: "devcontainer",
      inputs: { ".devcontainer.json": "a".repeat(40) },
      env: { MODE: "build", SHARED: "remote" },
    });
  });

  it("allows remoteEnv null to unset inherited or container values", async () => {
    const recipe = await resolve({
      ".devcontainer.json": entry(
        '{"containerEnv":{"MODE":"build"},"remoteEnv":{"MODE":null,"LANG":null}}',
      ),
    });
    expect(recipe.env).toEqual({ MODE: null, LANG: null });
    expect(EnvironmentRecipeSchema.parse(recipe).env).toEqual({ MODE: null, LANG: null });
  });

  it("admits resolved lifecycle recipes and rejects malformed transport commands", async () => {
    const recipe = await resolve({
      ".devcontainer.json": entry('{"onCreateCommand":["npm","ci"]}'),
    });
    expect(EnvironmentRecipeSchema.parse(recipe)).toEqual(recipe);
    expect(
      EnvironmentRecipeSchema.safeParse({ ...recipe, postStart: ["", "argument"] }).success,
    ).toBe(false);
    expect(EnvironmentRecipeSchema.safeParse({ ...recipe, identity: "not-a-blob" }).success).toBe(
      false,
    );
  });

  it("records one note for ignored properties without interpreting their values", async () => {
    const recipe = await resolve({
      ".devcontainer.json": entry(
        '{"image":123,"features":false,"hostRequirements":null,"customizations":[],"name":"App"}',
      ),
    });
    expect(recipe.ignoredPropertiesNote).toBe(
      "devcontainer customizations, features, hostRequirements, image ignored on cloud machines",
    );
    expect(recipe.onCreate).toBeUndefined();
  });

  it("preserves empty exec arguments and whitespace in shell commands", async () => {
    const recipe = await resolve({
      ".devcontainer.json": entry(
        '{"onCreateCommand":["printf","%s", ""],"postStartCommand":"  echo ready  "}',
      ),
    });
    expect(recipe.onCreate).toEqual(["printf", "%s", ""]);
    expect(recipe.postStart).toBe("  echo ready  ");
  });

  it.each([
    '{"onCreateCommand":42}',
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
      expect(recipe.env).toEqual({ COREPACK_ENABLE_AUTO_PIN: "0" });
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
