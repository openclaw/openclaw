import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { create as createTar } from "tar/raw";
import { vi } from "vitest";
import { writeFixtureJson } from "./cli-fixtures.test-support.js";

export const minimalManifest = {
  schemaVersion: 1,
  agent: { id: "demo-agent", name: "Demo Agent" },
};

export async function canonicalFuturePath(target: string): Promise<string> {
  return join(await realpath(dirname(target)), basename(target));
}

export async function writeManifestFile(
  tempDirs: { make(prefix: string): string },
  value: unknown = minimalManifest,
): Promise<string> {
  const dir = tempDirs.make("openclaw-templates-cli-");
  const path = join(dir, "CLAW.md");
  await writeFile(path, `---\n${JSON.stringify(value)}\n---\n`);
  return path;
}

export async function writePackageFixture(tempDirs: {
  make(prefix: string): string;
}): Promise<{ root: string; workspace: string }> {
  const root = tempDirs.make("openclaw-templates-cli-package-");
  await mkdir(join(root, "workspace"));
  await writeFile(join(root, "workspace", "AGENTS.md"), "# Demo\n", "utf8");
  await writeFixtureJson(join(root, "package.json"), {
    name: "@acme/demo-agent",
    version: "1.2.3",
    openclaw: { template: "CLAW.md" },
  });
  await writeFile(
    join(root, "CLAW.md"),
    `---\n${JSON.stringify({
      schemaVersion: 1,
      agent: { id: "demo-agent", name: "Demo Agent" },
      workspace: {
        bootstrapFiles: { "AGENTS.md": { source: "workspace/AGENTS.md" } },
      },
      skills: [{ ref: "@acme/demo-skill", version: "1.0.0" }],
      plugins: [],
    })}\n---\n`,
  );
  return { root, workspace: join(root, "target-workspace") };
}

export async function mockRegistryPackage(
  tempDirs: { make(prefix: string): string },
  root: string,
  failure?: "family" | "name" | "digest" | "version" | "trust",
) {
  const archive = join(tempDirs.make("openclaw-registry-archive-"), "package.tgz");
  await createTar({ gzip: true, file: archive, cwd: dirname(root) }, [root.split("/").at(-1)!]);
  const bytes = await readFile(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const npmIntegrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
  const name = "@acme/demo-agent";
  const pkg = {
    name,
    family: "template",
    displayName: "Demo",
    channel: "community",
    isOfficial: false,
    updatedAt: 1,
    latestVersion: failure === "version" ? "latest" : "1.2.3",
  };
  const artifact = {
    kind: "npm-pack",
    sha256: failure === "digest" ? "0".repeat(64) : sha256,
    npmIntegrity,
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = decodeURIComponent(url.pathname);
    if (route.endsWith("/artifact/download")) {
      return new Response(bytes, { headers: { "X-ClawHub-Artifact-Sha256": sha256 } });
    }
    if (route.endsWith("/artifact")) {
      return Response.json({ package: pkg, version: "1.2.3", artifact });
    }
    if (route.endsWith("/security")) {
      return Response.json({
        package: pkg,
        release: {
          version: "1.2.3",
          artifactKind: "npm-pack",
          artifactSha256: artifact.sha256,
          npmIntegrity,
        },
        overview: "Synthetic security review.",
        securityAuditUrl: "https://clawhub.ai/acme/templates/demo-agent/security-audit",
        verdict: failure === "trust" ? "suspicious" : "benign",
        trust: {
          scanStatus: "clean",
          moderationState: "approved",
          blockedFromDownload: false,
          reasons: [],
          pending: false,
          stale: false,
        },
      });
    }
    if (route === "/api/v1/packages/" + name) {
      return Response.json({
        package: {
          ...pkg,
          ...(failure === "family" ? { family: "plugin" } : {}),
          ...(failure === "name" ? { name: "@acme/other" } : {}),
        },
        owner: { handle: "acme" },
      });
    }
    throw new Error("Unexpected registry request: " + route);
  });
  return { name, integrity: "sha256:" + sha256 };
}
