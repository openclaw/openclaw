import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
      packages: [
        {
          kind: "skill",
          source: "clawhub",
          ref: "@acme/demo-skill",
          version: "1.0.0",
        },
      ],
    })}\n---\n`,
  );
  return { root, workspace: join(root, "target-workspace") };
}
