import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
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
  fs.mkdirSync(bin);
  fs.cpSync(path.join(".github/release", `${variant.name}-cli`), source, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.writeFileSync(
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
      expect(json(test.receipt)).toEqual({
        args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"],
        cwd: test.destination,
      });
      const output = Object.fromEntries(
        fs
          .readFileSync(test.output, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split(/[=](.*)/s, 2)),
      );
      expect(output).toEqual({
        cli: path.join(test.destination, "node_modules/.bin", variant.name),
        ...(variant.name === "vercel"
          ? { sandbox_cli: path.join(test.destination, "node_modules/.bin/sandbox") }
          : {}),
        integrity: json(path.join(test.source, "package-lock.json")).packages[
          `node_modules/${variant.name}`
        ].integrity,
        lock_sha256: variant.hash,
        version: variant.version,
      });
      expect(fs.statSync(test.destination).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(test.destination, "package-lock.json")).mode & 0o777).toBe(
        0o600,
      );
      expect(result.stdout).toBe(
        `Materialized ${variant.name}@${variant.version} from lock ${variant.hash}.\n`,
      );
    },
  );

  it.each(["changed lock", "wrong version", "missing Sandbox executable"])(
    "rejects %s before publishing outputs",
    (reason) => {
      const missingBin = reason === "missing Sandbox executable";
      const test = fixture(variants[missingBin ? 1 : 0]);
      const overrides: Record<string, string> = {};
      if (reason === "wrong version") {
        overrides.FIXTURE_CLI_VERSION = "0.0.0";
      } else if (missingBin) {
        overrides.FIXTURE_MISSING_BIN = "sandbox";
      } else {
        fs.writeFileSync(path.join(test.source, "package-lock.json"), "{}\n");
      }
      const result = test.run(overrides);
      expect({ status: result.status, published: fs.existsSync(test.output) }).toEqual({
        status: 1,
        published: false,
      });
      if (missingBin) {
        expect(result.stdout).toBe("");
      } else {
        expect(result.stderr).toBe(
          reason === "changed lock"
            ? "Pinned ClawHub CLI lock SHA-256 mismatch.\n"
            : "Pinned ClawHub CLI version mismatch: 0.0.0\n",
        );
      }
      if (reason !== "wrong version") {
        expect(fs.existsSync(test.receipt)).toBe(missingBin);
      }
    },
  );
});
