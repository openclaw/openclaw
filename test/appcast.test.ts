import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalSparkleBuildFromVersion } from "../scripts/sparkle-build.ts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../src/infra/runtime-worker-url.js";
import { toolingTsEntrypoints } from "./scripts/tooling-ts-runtime.test-support.js";

describe("canonicalSparkleBuildFromVersion", () => {
  it("runs the CLI from a linked checkout path", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "sparkle-cli-"));
    try {
      const repo = fileURLToPath(new URL("../", import.meta.url));
      const linkedRepo = path.join(fixture, "checkout");
      symlinkSync(repo, linkedRepo, "junction");
      const preparedScript = fileURLToPath(
        resolveRuntimeWorkerUrl(toolingTsEntrypoints.sparkleBuild),
      );
      const script = path.join(linkedRepo, path.relative(repo, preparedScript));
      for (const [version, status, stdout] of [
        ["2026.9.3", 0, "2609000390\n"],
        ["invalid", 1, ""],
      ] as const) {
        const result = spawnSync(
          process.execPath,
          [...resolveRuntimeWorkerArgv(pathToFileURL(script)), "canonical-build", version],
          {
            cwd: repo,
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(status);
        expect(result.stdout).toBe(stdout);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("keeps pre-transition appcast builds on the legacy date key", () => {
    expect(canonicalSparkleBuildFromVersion("2026.6.2")).toBe(2026060290);
  });

  it("uses monthly patch build keys from the June 2026 floor onward", () => {
    expect(canonicalSparkleBuildFromVersion("2026.6.5-beta.2")).toBe(2606000502);
    expect(canonicalSparkleBuildFromVersion("2026.6.32-beta.1")).toBe(2606003201);
    expect(canonicalSparkleBuildFromVersion("2026.6.32")).toBe(2606003290);
  });

  it("rejects invalid numeric prerelease lanes", () => {
    expect(canonicalSparkleBuildFromVersion("2026.6.5-beta.0")).toBeNull();
    expect(canonicalSparkleBuildFromVersion("2026.6.5-beta.9007199254740993")).toBeNull();
  });

  it("rejects unsafe numeric release parts and build floors", () => {
    expect(canonicalSparkleBuildFromVersion("2026.6.9007199254740993")).toBeNull();
    expect(canonicalSparkleBuildFromVersion("2026.6.90071992547410")).toBeNull();
  });
});
