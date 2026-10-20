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

function resolveAllArgBackedFromReferences(
  dockerfile: string,
): { stage: string; imageRef: string }[] {
  const argDefaults = resolveArgDefaults(dockerfile);
  const results: { stage: string; imageRef: string }[] = [];
  let stageIndex = 0;
  for (const line of dockerfile.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("FROM ")) {
      continue;
    }
    const imageRef = resolveFromImageRef(trimmed, argDefaults);
    // Only check FROM lines that use an ARG — literal `FROM scratch` etc. are intentionally unpinned.
    const usesArg = /FROM\s+\$(?:\{[A-Z0-9_]+\}|[A-Z0-9_]+)/.test(trimmed);
    if (usesArg) {
      const stage = trimmed.match(/AS\s+(\S+)/i)?.[1] ?? `stage-${stageIndex}`;
      results.push({ stage, imageRef });
    }
    stageIndex += 1;
  }
  return results;
}

describe("docker base image pinning", () => {
  it("pins selected Dockerfile FROM lines to immutable sha256 digests", async () => {
    for (const dockerfilePath of DIGEST_PINNED_DOCKERFILES) {
      const dockerfile = await readFile(resolve(repoRoot, dockerfilePath), "utf8");
      const fromLine = expectDefined(
        dockerfile.split(/\r?\n/).find((line) => line.trimStart().startsWith("FROM ")),
        `${dockerfilePath} should define a FROM line`,
      );
      const imageRef = resolveFromImageRef(fromLine, resolveArgDefaults(dockerfile));
      expect(imageRef, `${dockerfilePath} FROM must be digest-pinned`).toMatch(
        /^\S+@sha256:[a-f0-9]{64}$/,
      );
    }
  });

  it("pins all ARG-backed FROM stages in selected Dockerfiles to sha256 digests", async () => {
    for (const dockerfilePath of DIGEST_PINNED_DOCKERFILES) {
      const dockerfile = await readFile(resolve(repoRoot, dockerfilePath), "utf8");
      const stages = resolveAllArgBackedFromReferences(dockerfile);
      for (const { stage, imageRef } of stages) {
        expect(imageRef, `${dockerfilePath} stage "${stage}" must be digest-pinned`).toMatch(
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
