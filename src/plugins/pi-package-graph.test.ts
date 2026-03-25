import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type RootPackageManifest = {
  dependencies?: Record<string, string>;
  pnpm?: {
    overrides?: Record<string, string>;
  };
};

const PI_PACKAGE_NAMES = [
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-tui",
] as const;

function readRootManifest(): RootPackageManifest {
  const manifestPath = path.resolve(process.cwd(), "package.json");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as RootPackageManifest;
}

function isExactPinnedVersion(spec: string): boolean {
  return !spec.startsWith("^") && !spec.startsWith("~");
}

function isPiOverrideKey(key: string): boolean {
  return key.startsWith("@mariozechner/pi-") || key.includes("@mariozechner/pi-");
}

describe("pi package graph guardrails", () => {
  it("keeps root Pi packages aligned to the same exact version", () => {
    const manifest = readRootManifest();
    const dependencies = manifest.dependencies ?? {};
    const specs = PI_PACKAGE_NAMES.map((name) => ({
      name,
      spec: dependencies[name],
    }));

    const missing = specs.filter((entry) => !entry.spec).map((entry) => entry.name);
    expect(
      missing,
      `Missing required root Pi dependencies: ${missing.join(", ") || "<none>"}. Mixed or incomplete Pi root dependencies create an unsupported package graph.`,
    ).toEqual([]);

    const presentSpecs = specs.map((entry) => entry.spec);
    const uniqueSpecs = [...new Set(presentSpecs)];
    expect(
      uniqueSpecs,
      `Root Pi dependencies must stay aligned to one exact version. Found: ${specs.map((entry) => `${entry.name}=${entry.spec}`).join(", ")}. Mixed Pi versions create an unsupported package graph.`,
    ).toHaveLength(1);

    const inexact = specs.filter((entry) => !isExactPinnedVersion(entry.spec));
    expect(
      inexact,
      `Root Pi dependencies must use exact pins, not ranges. Found: ${inexact.map((entry) => `${entry.name}=${entry.spec}`).join(", ") || "<none>"}. Range-based Pi specs can silently create an unsupported package graph.`,
    ).toEqual([]);
  });

  it("forbids pnpm overrides that target Pi packages", () => {
    const manifest = readRootManifest();
    const overrides = manifest.pnpm?.overrides ?? {};
    const piOverrides = Object.keys(overrides).filter(isPiOverrideKey);

    expect(
      piOverrides,
      `pnpm.overrides must not target Pi packages. Found: ${piOverrides.join(", ") || "<none>"}. Pi-specific overrides can silently create an unsupported package graph.`,
    ).toEqual([]);
  });
});
