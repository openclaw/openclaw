import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import type { ClawAddPlan, ClawSourceIdentity } from "./types.js";

export async function createClawAgentAdoptionFixture(
  root: string,
  options: {
    createWorkspace?: boolean;
    plugin?: boolean;
    bootstrap?: boolean;
    managedFile?: boolean;
  } = {},
): Promise<{
  root: string;
  plan: ClawAddPlan;
  config: OpenClawConfig;
}> {
  const workspace = join(root, "workspace");
  if (options.createWorkspace !== false) {
    await mkdir(workspace);
  }
  if (options.managedFile) {
    await mkdir(join(root, "content"));
    await writeFile(join(root, "content", "SKILL.md"), "managed by claw");
  }
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "worker", name: "Worker" },
    ...(options.managedFile
      ? { workspace: { files: [{ source: "content/SKILL.md", path: "SKILL.md" }] } }
      : {}),
    ...(options.plugin
      ? {
          packages: [
            {
              kind: "plugin" as const,
              source: "clawhub" as const,
              ref: "@acme/audit",
              version: "1.0.0",
            },
          ],
        }
      : {}),
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 1,
  };
  const existing = { id: "worker", name: "Worker", workspace, default: true };
  const bootstrapContent = "# First run\n";
  const bootstrapPath = join(root, "BOOTSTRAP.md");
  if (options.bootstrap) {
    await writeFile(bootstrapPath, bootstrapContent);
  }
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    ...(options.bootstrap
      ? {
          packageBootstrap: {
            sourcePath: "BOOTSTRAP.md",
            realPath: bootstrapPath,
            byteLength: Buffer.byteLength(bootstrapContent),
            digest: `sha256:${createHash("sha256").update(bootstrapContent).digest("hex")}`,
          },
        }
      : {}),
    context: {
      workspace,
      adoptExistingAgent: true,
      existingAgents: [existing],
      ...(options.plugin
        ? {
            packagePreflight: async () => ({
              ok: true as const,
              action: "install" as const,
              integrity: `sha256:${"a".repeat(64)}`,
              installId: "audit",
            }),
          }
        : {}),
    },
  });
  return {
    root,
    plan,
    config: { agents: { entries: { worker: { name: "Worker", workspace, default: true } } } },
  };
}
