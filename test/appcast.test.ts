// Appcast tests validate generated update appcast metadata.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { canonicalSparkleBuildFromVersion } from "../scripts/sparkle-build.ts";

const APPCAST_URL = new URL("../appcast.xml", import.meta.url);

type AppcastItem = {
  raw: string;
  shortVersion: string | null;
  sparkleVersion: number | null;
};

describe("canonicalSparkleBuildFromVersion", () => {
  it.each(["direct", "linked"])("runs the CLI from a %s checkout path", (kind) => {
    const fixture = mkdtempSync(path.join(tmpdir(), "sparkle-cli-"));
    try {
      const repo = fileURLToPath(new URL("../", import.meta.url));
      const linkedRepo = path.join(fixture, "checkout");
      symlinkSync(repo, linkedRepo, "junction");
      const script = path.join(kind === "linked" ? linkedRepo : repo, "scripts/sparkle-build.ts");
      for (const [version, status, stdout] of [
        ["2026.9.3", 0, "2609000390\n"],
        ["invalid", 1, ""],
      ] as const) {
        const result = spawnSync(
          process.execPath,
          ["--import", "tsx", script, "canonical-build", version],
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

function parseItems(appcast: string): AppcastItem[] {
  return [...appcast.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => {
    const raw = match[1] ?? "";
    const shortVersion =
      raw.match(/<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/)?.[1] ?? null;
    const sparkleVersionText = raw.match(/<sparkle:version>([^<]+)<\/sparkle:version>/)?.[1] ?? "";
    const sparkleVersion = Number.parseInt(sparkleVersionText, 10);
    return {
      raw,
      shortVersion,
      sparkleVersion: Number.isFinite(sparkleVersion) ? sparkleVersion : null,
    };
  });
}

describe("appcast.xml", () => {
  it("keeps every appcast entry on the canonical sparkle build for its version", () => {
    const appcast = readFileSync(APPCAST_URL, "utf8");
    const items = parseItems(appcast);
    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      if (item.shortVersion === null || item.sparkleVersion === null) {
        throw new Error(`Appcast entry missing version fields: ${item.raw}`);
      }
      expect(item.sparkleVersion).toBe(canonicalSparkleBuildFromVersion(item.shortVersion));
      expect(item.raw).toMatch(/sparkle:edSignature="[^"]+"/u);
    }
  });

  it("keeps the first stable appcast entry aligned with the newest stable build", () => {
    const appcast = readFileSync(APPCAST_URL, "utf8");
    const stableItems = parseItems(appcast).filter(
      (item) => item.sparkleVersion !== null && item.sparkleVersion % 100 === 90,
    );

    expect(stableItems.length).toBeGreaterThan(0);
    const firstStable = expectDefined(stableItems[0], "first stable appcast item");
    const newestStable = expectDefined(
      [...stableItems].toSorted(
        (left, right) => (right.sparkleVersion ?? 0) - (left.sparkleVersion ?? 0),
      )[0],
      "newest stable appcast item",
    );

    expect(firstStable.sparkleVersion).toBe(newestStable.sparkleVersion);
    expect(firstStable.shortVersion).toBe(newestStable.shortVersion);
  });
});
