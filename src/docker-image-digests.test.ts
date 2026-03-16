import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const DIGEST_PINNED_DOCKERFILES = [
  "Dockerfile",
  "Dockerfile.sandbox",
  "Dockerfile.sandbox-browser",
  "scripts/docker/cleanup-smoke/Dockerfile",
  "scripts/docker/install-sh-e2e/Dockerfile",
  "scripts/docker/install-sh-nonroot/Dockerfile",
  "scripts/docker/install-sh-smoke/Dockerfile",
  "scripts/e2e/Dockerfile",
  "scripts/e2e/Dockerfile.qr-import",
] as const;

type DependabotDockerGroup = {
  patterns?: string[];
};

type DependabotUpdate = {
  "package-ecosystem"?: string;
  directory?: string;
  schedule?: { interval?: string };
  groups?: Record<string, DependabotDockerGroup>;
};

type DependabotConfig = {
  updates?: DependabotUpdate[];
};

function resolveFirstFromReference(dockerfile: string): string | undefined {
  const argDefaults = new Map<string, string>();

  for (const line of dockerfile.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("FROM ")) {
      break;
    }
    const argMatch = trimmed.match(/^ARG\s+([A-Z0-9_]+)=(.+)$/);
    if (!argMatch) {
      continue;
    }
    const [, name, rawValue] = argMatch;
    const value = rawValue.replace(/^["']|["']$/g, "");
    argDefaults.set(name, value);
  }

  const fromLine = dockerfile.split(/\r?\n/).find((line) => line.trimStart().startsWith("FROM "));
  if (!fromLine) {
    return undefined;
  }

  const fromMatch = fromLine.trim().match(/^FROM\s+(\S+?)(?:\s+AS\s+\S+)?$/);
  if (!fromMatch) {
    return undefined;
  }
  const imageRef = fromMatch[1];
  const argName =
    imageRef.match(/^\$\{([A-Z0-9_]+)\}$/)?.[1] ?? imageRef.match(/^\$([A-Z0-9_]+)$/)?.[1];

  if (!argName) {
    return imageRef;
  }
  return argDefaults.get(argName);
}

describe("docker base image pinning", () => {
  it("pins selected Dockerfile FROM lines to immutable sha256 digests", async () => {
    for (const dockerfilePath of DIGEST_PINNED_DOCKERFILES) {
      const dockerfile = await readFile(resolve(repoRoot, dockerfilePath), "utf8");
      const imageRef = resolveFirstFromReference(dockerfile);
      expect(imageRef, `${dockerfilePath} should define a FROM line`).toBeDefined();
      expect(imageRef, `${dockerfilePath} FROM must be digest-pinned`).toMatch(
        /^\S+@sha256:[a-f0-9]{64}$/,
      );
    }
  });

  it("keeps Dependabot Docker updates enabled for root Dockerfiles", async () => {
    const raw = await readFile(resolve(repoRoot, ".github/dependabot.yml"), "utf8");
    const config = parse(raw) as DependabotConfig;
    const dockerUpdate = config.updates?.find(
      (update) => update["package-ecosystem"] === "docker" && update.directory === "/",
    );

    expect(dockerUpdate).toBeDefined();
    expect(dockerUpdate?.schedule?.interval).toBe("weekly");
    expect(dockerUpdate?.groups?.["docker-images"]?.patterns).toContain("*");
  });
});
