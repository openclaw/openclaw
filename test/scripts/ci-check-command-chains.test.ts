import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;

describe("CI package check chains", () => {
  it.each([
    ["check:docs", ["format:docs:check", "check:docs:content"]],
    [
      "check:docs:content",
      [
        "lint:docs",
        "lint:templates",
        "docs:check-mdx",
        "docs:check-i18n-glossary",
        "docs:check-links",
        "docs:check-config-examples",
        "changelog:check",
      ],
    ],
    ["tsgo:test", ["tsgo:core:test", "tsgo:extensions:test", "tsgo:test:root"]],
    ["tsgo:prod", ["tsgo:core", "tsgo:ui", "tsgo:extensions"]],
  ] as const)(
    "%s executes its complete inventory after the first check fails",
    (name, expected) => {
      const root = tempDirs.make("ci-check-chain-");
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      const calls = path.join(root, "calls");
      writeFileSync(
        path.join(bin, "pnpm"),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n[ "$*" != "$FAIL_CHECK" ]\n',
        { mode: 0o755 },
      );
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", scripts[name]!], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          CALLS: calls,
          FAIL_CHECK: expected[0],
        },
      });
      expect(result.status, result.stderr).toBe(1);
      expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(expected);
    },
  );
});
