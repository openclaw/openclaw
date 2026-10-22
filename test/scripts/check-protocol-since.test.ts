import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runGit } from "./ci-workflow.test-support.js";
import { runProtocolSinceFixture } from "./protocol-since.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const descriptors = "src/gateway/methods/core-descriptors.ts";
const additions = "src/gateway/methods/core-descriptor-additions.ts";
const existing = '["sessions.existing", "sessions", "operator.read", "2026.7"]';
const added = '["sessions.new", "sessions", "operator.read", "2026.8"]';

function writeSource(checkout: string, file: string, contents: string) {
  const target = path.join(checkout, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function rootSource(importPath = "./core-descriptor-additions.js", trailing = "") {
  return [
    "import { CORE_GATEWAY_METHOD_ADDITIONS as SUFFIX } from " + JSON.stringify(importPath) + ";",
    "export const CORE_GATEWAY_METHOD_SPECS = [",
    '["health", "health", "operator.read", "2026.7"],',
    "...SUFFIX," + trailing,
    "] as const;",
  ].join("\n");
}

function suffixSource(rows: string[]) {
  return "export const CORE_GATEWAY_METHOD_ADDITIONS = [" + rows.join(",\n") + "] as const;";
}

function fixture() {
  const checkout = tempDirs.make("openclaw-protocol-suffix-");
  runGit(checkout, ["init", "-q", "-b", "main"]);
  runGit(checkout, ["config", "user.name", "Protocol Fixture"]);
  runGit(checkout, ["config", "user.email", "fixture@example.invalid"]);
  runGit(checkout, ["config", "commit.gpgsign", "false"]);
  writeSource(
    checkout,
    "package.json",
    JSON.stringify({ name: "qa-protocol-fixture", version: "2026.8.0" }),
  );
  writeSource(checkout, descriptors, rootSource());
  writeSource(checkout, additions, suffixSource([existing]));
  runGit(checkout, ["add", "."]);
  runGit(checkout, ["commit", "-qm", "fixture base"]);
  return { checkout, base: runGit(checkout, ["rev-parse", "HEAD"]) };
}

describe("protocol since imported suffix", () => {
  it("compares the historical imported suffix and accepts a literal append through an alias", () => {
    const { checkout, base } = fixture();
    writeSource(checkout, additions, suffixSource([existing, added]));
    const result = runProtocolSinceFixture(checkout, base);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("1 new core method");
  });

  it("enforces literal vintage, unique identities, and append-only order in imported rows", () => {
    const { checkout, base } = fixture();
    const cases = [
      [
        suffixSource([existing, '{ name: "sessions.new" }']),
        "sessions.new is missing since metadata",
      ],
      [
        suffixSource([existing, '["sessions.new", "sessions", "operator.read"]']),
        "string literal names and vintage metadata",
      ],
      [
        suffixSource([existing, '["sessions.new", "sessions", "operator.read", train]']),
        "string literal names and vintage metadata",
      ],
      [suffixSource([existing, added.replace("2026.8", "2026.13")]), "has invalid vintage"],
      [suffixSource([existing, added.replace("2026.8", "2026.7")]), 'add since: "2026.8"'],
      [
        suffixSource([existing, added.replace("sessions.new", "health")]),
        "duplicate core method identity health",
      ],
      [
        suffixSource([existing, '["sessions.new", ...shifted, "operator.read", "2026.8"]']),
        "string literal names and vintage metadata",
      ],
      [suffixSource([existing, existing]), "duplicate core method identity sessions.existing"],
      [suffixSource([added, existing]), "append-only; preserve existing method order"],
    ] as const;
    for (const [source, message] of cases) {
      writeSource(checkout, additions, source);
      const result = runProtocolSinceFixture(checkout, base);
      expect(result.status, source + result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(message);
    }
  });

  it("rejects unsupported imports, nonterminal spreads, and dynamic suffix expressions without evaluating them", () => {
    const { checkout, base } = fixture();
    const cases = [
      [rootSource("./elsewhere.js"), suffixSource([existing]), "named static import"],
      [
        rootSource().replace("import {", "import type {"),
        suffixSource([existing]),
        "named static import",
      ],
      [
        rootSource().replace("{ CORE", "{ type CORE"),
        suffixSource([existing]),
        "named static import",
      ],
      [rootSource(undefined, added), suffixSource([existing]), "final spread"],
      [
        rootSource(),
        'export const CORE_GATEWAY_METHOD_ADDITIONS = (() => { throw new Error("must not execute"); })();',
        "exported const literal array",
      ],
      [
        rootSource(),
        suffixSource([existing, "...otherRows"]),
        "inline object literals or labeled rows",
      ],
    ] as const;
    for (const [root, suffix, message] of cases) {
      writeSource(checkout, descriptors, root);
      writeSource(checkout, additions, suffix);
      const result = runProtocolSinceFixture(checkout, base);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toContain("must not execute");
    }
  });
});
