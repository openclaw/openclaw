import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const guard = fileURLToPath(
  new URL("../../scripts/check-install-dependency-ownership.mjs", import.meta.url),
);
const configKeys = ["PNPM_CONFIG_MODULES_DIR", "pnpm_config_modules_dir", "npm_config_modules_dir"];
const sentinel = "another task owns these bytes";

function fixture(directory = "donor") {
  const root = fs.realpathSync(createTempDir("openclaw-install-ownership-"));
  const checkout = path.join(root, "checkout");
  const donor = path.join(directory === "donor" ? root : checkout, directory);
  fs.mkdirSync(checkout);
  fs.mkdirSync(donor);
  fs.writeFileSync(path.join(donor, "sentinel"), sentinel);
  return {
    checkout,
    donor,
    modules: path.join(checkout, "node_modules"),
    run: (env: NodeJS.ProcessEnv = {}) =>
      spawnSync(process.execPath, [guard], { cwd: checkout, env, encoding: "utf8" }),
  };
}

const link = (target: string, destination: string) =>
  fs.symlinkSync(target, destination, process.platform === "win32" ? "junction" : "dir");

it.each(["absent", "physical"])("admits %s without changing the checkout", (kind) => {
  const { checkout, modules, run } = fixture();
  if (kind === "physical") {
    fs.mkdirSync(modules);
  }
  const before = fs.readdirSync(checkout);
  expect(run().status).toBe(0);
  expect(fs.readdirSync(checkout)).toEqual(before);
});

it.each(["modules", "virtual-store", "unrelated-config", "empty-uppercase", ...configKeys])(
  "refuses borrowed dependencies (%s) without touching the donor",
  (kind) => {
    const f = fixture();
    const { checkout, donor } = f;
    const custom = configKeys.includes(kind);
    const env: NodeJS.ProcessEnv = custom ? { [kind]: "custom_modules" } : {};
    const target = path.join(
      checkout,
      custom ? "custom_modules" : kind === "virtual-store" ? "node_modules/.pnpm" : "node_modules",
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    link(donor, target);
    if (kind === "unrelated-config") {
      env.PNPM_CONFIG_MODULES_DIR = path.join(checkout, "explicit-modules");
      fs.mkdirSync(env.PNPM_CONFIG_MODULES_DIR);
    } else if (kind === "empty-uppercase") {
      env.PNPM_CONFIG_MODULES_DIR = "";
      env.pnpm_config_modules_dir = donor;
    }
    const before = fs.statSync(donor);
    expect(f.run(env)).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("Refusing to reconcile dependencies"),
    });
    expect(fs.statSync(donor)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs });
    expect(fs.readFileSync(path.join(donor, "sentinel"), "utf8")).toBe(sentinel);
    expect(fs.realpathSync(target)).toBe(donor);
  },
);

it.each([
  ...configKeys.map((key) => ({ key, directory: "donor" })),
  { key: "PNPM_CONFIG_MODULES_DIR", directory: "modules " },
])("admits explicit alias via $key ($directory)", ({ key, directory }) => {
  const { donor, modules, run } = fixture(directory);
  link(donor, modules);
  const before = fs.lstatSync(modules);
  expect(run({ [key]: donor }).status).toBe(0);
  expect(fs.lstatSync(modules).ino).toBe(before.ino);
  expect(fs.realpathSync(modules)).toBe(donor);
});
