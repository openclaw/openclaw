import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const variants = [
  {
    name: "clawhub",
    version: "0.23.3",
    hash: "8dc2d1dadd9c2423b87752c7fde83bf40018a30a46edb80166c43e458690f2b0",
  },
  {
    name: "vercel",
    version: "63.1.2",
    hash: "81a44227cdb0fdb14aeb166302ae0c44ccd91cd99ab9e19d95b507b53373bf74",
  },
] as const;

function fixture(variant: (typeof variants)[number]) {
  const root = tempDirs.make("openclaw-pinned-cli-");
  const source = path.join(root, "source");
  const destination = path.join(root, "installed");
  const output = path.join(root, "github-output");
  const receipt = path.join(root, "npm-receipt.json");
  const bin = path.join(root, "bin");
  mkdirSync(source);
  mkdirSync(bin);
  for (const name of ["package.json", "package-lock.json"]) {
    copyFileSync(
      path.join(".github/release", `${variant.name}-cli`, name),
      path.join(source, name),
    );
  }
  symlinkSync(process.execPath, path.join(bin, "node"));
  writeFileSync(
    path.join(bin, "npm"),
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(process.env.FIXTURE_NPM_RECEIPT, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
const packageDir = path.join("node_modules", process.env.FIXTURE_CLI_PACKAGE);
fs.mkdirSync(packageDir, { recursive: true });
fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version: process.env.FIXTURE_CLI_VERSION }));
fs.mkdirSync("node_modules/.bin", { recursive: true });
for (const name of [process.env.FIXTURE_CLI_PACKAGE, "sandbox"]) {
  if (name !== process.env.FIXTURE_MISSING_BIN) fs.writeFileSync(path.join("node_modules/.bin", name), "", { mode: 0o755 });
}
`,
    { mode: 0o755 },
  );
  return {
    root,
    source,
    destination,
    output,
    receipt,
    run(overrides: Record<string, string> = {}) {
      return spawnSync(
        "/bin/bash",
        [path.resolve(`scripts/materialize-${variant.name}-cli.sh`), source, destination, output],
        {
          encoding: "utf8",
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            HOME: root,
            OPENCLAW_HOME: path.join(root, ".openclaw"),
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
            XDG_CONFIG_HOME: path.join(root, "config"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_STATE_HOME: path.join(root, "xdg-state"),
            XDG_RUNTIME_DIR: path.join(root, "run"),
            FIXTURE_NPM_RECEIPT: receipt,
            FIXTURE_CLI_PACKAGE: variant.name,
            FIXTURE_CLI_VERSION: variant.version,
            ...overrides,
          },
        },
      );
    },
  };
}

describe("pinned release CLI materialization", () => {
  it.each(variants)(
    "materializes $name without lifecycle scripts and preserves workflow outputs",
    (variant) => {
      const test = fixture(variant);
      const result = test.run();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(test.receipt, "utf8"))).toEqual({
        args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"],
        cwd: test.destination,
      });
      const output = Object.fromEntries(
        readFileSync(test.output, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
      expect(output).toEqual({
        cli: path.join(test.destination, "node_modules/.bin", variant.name),
        ...(variant.name === "vercel"
          ? { sandbox_cli: path.join(test.destination, "node_modules/.bin/sandbox") }
          : {}),
        integrity: JSON.parse(readFileSync(path.join(test.source, "package-lock.json"), "utf8"))
          .packages[`node_modules/${variant.name}`].integrity,
        lock_sha256: variant.hash,
        version: variant.version,
      });
      expect(statSync(test.destination).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(test.destination, "package-lock.json")).mode & 0o777).toBe(0o600);
      expect(result.stdout).toBe(
        `Materialized ${variant.name}@${variant.version} from lock ${variant.hash}.\n`,
      );
    },
  );

  it("rejects a changed lock before invoking npm or publishing outputs", () => {
    const test = fixture(variants[0]);
    writeFileSync(path.join(test.source, "package-lock.json"), "{}\n");
    const result = test.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Pinned ClawHub CLI lock SHA-256 mismatch.\n");
    expect(existsSync(test.receipt)).toBe(false);
    expect(existsSync(test.output)).toBe(false);
  });

  it("rejects an unexpected installed version before publishing outputs", () => {
    const test = fixture(variants[0]);
    const result = test.run({ FIXTURE_CLI_VERSION: "0.0.0" });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Pinned ClawHub CLI version mismatch: 0.0.0\n");
    expect(existsSync(test.output)).toBe(false);
  });

  it("requires Vercel's standalone Sandbox executable before publishing outputs", () => {
    const test = fixture(variants[1]);
    const result = test.run({ FIXTURE_MISSING_BIN: "sandbox" });
    expect(result.status).toBe(1);
    expect(existsSync(test.receipt)).toBe(true);
    expect(existsSync(test.output)).toBe(false);
    expect(result.stdout).toBe("");
  });
});
