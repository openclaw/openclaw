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

function digestReferences(dockerfile: string): string[] {
  const lines = dockerfile.split(/\r?\n/).map((line) => line.trim());
  const argDefaults = new Map(
    lines.flatMap((line) => {
      const match = line.match(/^ARG\s+([A-Z0-9_]+)=(.+)$/);
      if (!match) {
        return [];
      }
      const [, name, rawValue] = match;
      return [
        [
          expectDefined(name, "name test invariant"),
          expectDefined(rawValue, "rawValue test invariant").replace(/^["']|["']$/g, ""),
        ] as const,
      ];
    }),
  );
  const fromLines = lines.filter((line) => line.startsWith("FROM "));
  expect(fromLines.length, "Dockerfile should define a FROM line").toBeGreaterThan(0);
  // Check the base and every ARG-backed stage; later literal stages may be scratch or aliases.
  return fromLines
    .filter((line, index) => index === 0 || /FROM\s+\$(?:\{[A-Z0-9_]+\}|[A-Z0-9_]+)/.test(line))
    .map((line) => {
      const match = line.match(/^FROM\s+(\S+?)(?:\s+AS\s+\S+)?$/);
      if (!match) {
        return line;
      }
      const image = expectDefined(match[1], "FROM image");
      const arg = image.match(/^\$\{([A-Z0-9_]+)\}$/)?.[1] ?? image.match(/^\$([A-Z0-9_]+)$/)?.[1];
      return arg ? (argDefaults.get(arg) ?? image) : image;
    });
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
