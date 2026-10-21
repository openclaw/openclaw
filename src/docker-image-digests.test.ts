import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const DIGEST_PINNED_DOCKERFILES = [
  "Dockerfile",
  "scripts/docker/sandbox/Dockerfile",
  "scripts/docker/sandbox/Dockerfile.browser",
  "scripts/docker/cleanup-smoke/Dockerfile",
  "scripts/docker/install-sh-e2e/Dockerfile",
  "scripts/docker/install-sh-nonroot/Dockerfile",
  "scripts/docker/install-sh-smoke/Dockerfile",
  "scripts/e2e/Dockerfile",
  "scripts/e2e/Dockerfile.qr-import",
  "scripts/e2e/plugin-binding-command-escape.Dockerfile",
] as const;

type DependabotConfig = {
  updates?: {
    "package-ecosystem"?: string;
    directory?: string;
    schedule?: { interval?: string };
    groups?: Record<string, { patterns?: string[] }>;
  }[];
};

function resolveArgDefaults(dockerfile: string): Map<string, string> {
  const argDefaults = new Map<string, string>();
  for (const line of dockerfile.split(/\r?\n/)) {
    const argMatch = line.trim().match(/^ARG\s+([A-Z0-9_]+)=(.+)$/);
    if (!argMatch) {
      continue;
    }
    const [, name, rawValue] = argMatch;
    argDefaults.set(
      expectDefined(name, "name test invariant"),
      expectDefined(rawValue, "rawValue test invariant").replace(/^["']|["']$/g, ""),
    );
  }
  return argDefaults;
}

function resolveFromImageRef(fromLine: string, argDefaults: Map<string, string>): string {
  const fromMatch = fromLine.trim().match(/^FROM\s+(\S+?)(?:\s+AS\s+\S+)?$/);
  if (!fromMatch) {
    return fromLine;
  }
  const imageRef = expectDefined(fromMatch[1], "fromMatch[1] test invariant");
  const argName =
    imageRef.match(/^\$\{([A-Z0-9_]+)\}$/)?.[1] ?? imageRef.match(/^\$([A-Z0-9_]+)$/)?.[1];
  if (!argName) {
    return imageRef;
  }
  return argDefaults.get(argName) ?? imageRef;
}

function digestReferences(dockerfile: string): string[] {
  const argDefaults = resolveArgDefaults(dockerfile);
  const fromLines = dockerfile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("FROM "));
  expect(fromLines.length, "Dockerfile should define a FROM line").toBeGreaterThan(0);
  // Check the base and every ARG-backed stage; later literal stages may be scratch or aliases.
  return fromLines
    .filter((line, index) => index === 0 || /FROM\s+\$(?:\{[A-Z0-9_]+\}|[A-Z0-9_]+)/.test(line))
    .map((line) => resolveFromImageRef(line, argDefaults));
}

describe("docker base image pinning", () => {
  it("pins the base and every ARG-backed FROM stage to immutable sha256 digests", async () => {
    for (const dockerfilePath of DIGEST_PINNED_DOCKERFILES) {
      const dockerfile = await readFile(resolve(repoRoot, dockerfilePath), "utf8");
      for (const imageRef of digestReferences(dockerfile)) {
        expect(imageRef, `${dockerfilePath} FROM ${imageRef} must be digest-pinned`).toMatch(
          /^\S+@sha256:[a-f0-9]{64}$/,
        );
      }
    }
  });

  it("keeps Dependabot Docker updates enabled for root Dockerfiles", async () => {
    const raw = await readFile(resolve(repoRoot, ".github/dependabot.yml"), "utf8");
    const config = parse(raw) as DependabotConfig;
    const dockerUpdate = config.updates?.find(
      (update) => update["package-ecosystem"] === "docker" && update.directory === "/",
    );
    expect(dockerUpdate).toMatchObject({
      schedule: { interval: "weekly" },
      groups: { "docker-images": { patterns: expect.arrayContaining(["*"]) } },
    });
  });
});
