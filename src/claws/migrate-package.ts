import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { assertNoSymlinkParents } from "@openclaw/fs-safe/advanced";
import { stringify as stringifyYaml } from "yaml";
import type { AgentConfig } from "../config/types.agents.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { portableAgent, portableOpenClawProfile } from "./export.js";
import { ClawMigrationError } from "./migrate-errors.js";
import { MAX_MANAGED_FILE_BYTES } from "./source-limits.js";
import { CLAW_BOOTSTRAP_FILE_NAMES } from "./types.js";
import type { ClawManifest, ClawOpenClawProfile } from "./types.js";

export type CapturedWorkspaceFile = {
  name: (typeof CLAW_BOOTSTRAP_FILE_NAMES)[number];
  content: Buffer;
  digest: string;
};

export function lstatMigrationPathIfExists(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
}

export function packageIdentityDigest(files: Map<string, Buffer>): {
  integrity: string;
  byteLength: number;
} {
  const hash = createHash("sha256");
  let byteLength = 0;
  for (const [path, content] of [...files.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const pathBytes = Buffer.from(path, "utf8");
    hash.update(`${pathBytes.byteLength}:${pathBytes.toString("utf8")}:${content.byteLength}:`);
    hash.update(content);
    byteLength += content.byteLength;
  }
  return { integrity: `sha256:${hash.digest("hex")}`, byteLength };
}

export function generatedPackage(
  agentId: string,
  params: {
    agent: AgentConfig;
    avatar?: string;
    files: CapturedWorkspaceFile[];
  },
): {
  manifest: ClawManifest;
  profile?: ClawOpenClawProfile;
  body?: Buffer;
  packageFiles: Map<string, Buffer>;
} {
  const bootstrapFiles: ClawManifest["workspace"]["bootstrapFiles"] = {};
  const workspaceFiles: ClawManifest["workspace"]["files"] = [];
  const packageFiles = new Map<string, Buffer>();
  let body: Buffer | undefined;
  for (const file of params.files) {
    if (file.name === "SOUL.md" && file.content.toString("utf8").trim().length > 0) {
      body = file.content;
      continue;
    }
    bootstrapFiles[file.name] = {
      source: `workspace/${file.name}`,
    };
    packageFiles.set(`workspace/${file.name}`, file.content);
  }
  const agent = portableAgent(params.agent, params.avatar);
  const profile = portableOpenClawProfile(params.agent, []);
  const manifest: ClawManifest = {
    schemaVersion: 1,
    agent,
    workspace: { bootstrapFiles, files: workspaceFiles },
    packages: [],
    mcpServers: {},
    cronJobs: [],
  };
  const clawMarkdownFrontmatter = ["---", stringifyYaml(manifest).trimEnd(), "---", ""].join("\n");
  packageFiles.set(
    "CLAW.md",
    body
      ? Buffer.concat([Buffer.from(clawMarkdownFrontmatter, "utf8"), body])
      : Buffer.from(`${clawMarkdownFrontmatter}\n`, "utf8"),
  );
  packageFiles.set(
    "package.json",
    Buffer.from(
      `${JSON.stringify(
        {
          name: `openclaw-agent-${agentId}-local`,
          version: "1.0.0",
          type: "module",
          openclaw: { claw: "CLAW.md" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
  );
  if (profile) {
    packageFiles.set("profiles/openclaw.yml", Buffer.from(stringifyYaml(profile), "utf8"));
  }
  return { manifest, profile, body, packageFiles };
}

export async function createGeneratedPackage(
  root: string,
  packageFiles: Map<string, Buffer>,
): Promise<void> {
  const parent = dirname(root);
  let existingAncestor = parent;
  while (!(await lstatMigrationPathIfExists(existingAncestor))) {
    const next = dirname(existingAncestor);
    if (next === existingAncestor) {
      throw new ClawMigrationError(
        "package_parent_unavailable",
        `Could not find an existing parent for generated package ${JSON.stringify(root)}.`,
        "$.packageRoot",
      );
    }
    existingAncestor = next;
  }
  const ancestorInfo = await lstat(existingAncestor);
  if (!ancestorInfo.isDirectory() || ancestorInfo.isSymbolicLink()) {
    throw new ClawMigrationError(
      "package_parent_unsafe",
      `Generated package parent ${JSON.stringify(existingAncestor)} must be a real directory.`,
      "$.packageRoot",
    );
  }
  const realAncestor = await realpath(existingAncestor);
  await assertNoSymlinkParents({
    rootDir: realAncestor,
    targetPath: parent,
    allowMissing: true,
    messagePrefix: "Generated Claw package parent",
  });
  await mkdir(parent, { recursive: true });
  const parentInfo = await lstat(parent);
  const realParent = await realpath(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || realParent !== parent) {
    throw new ClawMigrationError(
      "package_parent_unsafe",
      `Generated package parent ${JSON.stringify(parent)} changed or resolves through a symlink; inspect the state directory before retrying.`,
      "$.packageRoot",
    );
  }
  await assertNoSymlinkParents({
    rootDir: realParent,
    targetPath: root,
    allowMissing: true,
    messagePrefix: "Generated Claw package",
  });
  await mkdir(root, { recursive: false });
  try {
    for (const [path, content] of packageFiles) {
      const target = resolve(root, path);
      const child = relative(root, target);
      if (child === ".." || child.startsWith(`..${sep}`)) {
        throw new Error("Generated package path escaped its destination.");
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { flag: "wx" });
    }
  } catch (error) {
    await removeGeneratedPackageIfUnchanged(root, packageFiles);
    throw error;
  }
}

export async function removeGeneratedPackageIfUnchanged(
  root: string,
  packageFiles: Map<string, Buffer>,
): Promise<void> {
  for (const [path, expected] of [...packageFiles.entries()].toReversed()) {
    const target = resolve(root, path);
    const info = await lstatMigrationPathIfExists(target);
    if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      continue;
    }
    const actual = await fsSafeRoot(dirname(target))
      .then((parent) =>
        parent.read(target.slice(dirname(target).length + 1), {
          hardlinks: "reject",
          maxBytes: MAX_MANAGED_FILE_BYTES,
          symlinks: "reject",
        }),
      )
      .catch(() => undefined);
    if (actual && sha256(actual.buffer) === sha256(expected)) {
      await unlink(target).catch(() => undefined);
    }
  }
  for (const directory of [resolve(root, "profiles"), resolve(root, "workspace"), root]) {
    await rmdir(directory).catch(() => undefined);
  }
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function createPackagePreview(packageFiles: Map<string, Buffer>): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "openclaw-claws-migrate-"));
  try {
    for (const [path, content] of packageFiles) {
      const target = resolve(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { flag: "wx" });
    }
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function removePackagePreview(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
