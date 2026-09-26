import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect } from "vitest";
import {
  PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "../../scripts/lib/package-lifecycle-marker.mjs";
import { WORKSPACE_TEMPLATE_PACK_PATHS } from "../../scripts/lib/workspace-bootstrap-smoke.mts";
import { resolveNpmRunner } from "../../scripts/npm-runner.mts";
import { resolvePnpmRunner } from "../../scripts/pnpm-runner.mts";

export const CODE_MODE_WORKER_PATH = "dist/agents/code-mode.worker.js";

function chmodTreeWorldReadable(dir: string) {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      chmodTreeWorldReadable(entryPath);
    } else if (!entry.isSymbolicLink()) {
      chmodSync(entryPath, 0o644);
    }
  }
}

export function listFilesRecursively(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(prefix, entry.name);
    return entry.isDirectory()
      ? listFilesRecursively(join(dir, entry.name), relativePath)
      : [relativePath];
  });
}

export function withTarball(
  inventory: string[],
  files: Record<string, string>,
  testBody: (tarball: string, root: string, packageRoot: string) => void,
  version = "2026.7.2",
  options: {
    includeCodeModeWorker?: boolean;
    includeCodeModeWorkerInInventory?: boolean;
    includeControlUi?: boolean;
    emptyDirectories?: string[];
    filesOnlyArchive?: boolean;
    includeLifecycleMarker?: boolean;
    includeShrinkwrap?: boolean;
    includeWorkspaceTemplates?: boolean;
    inventoryBody?: string | null;
    packageJson?: Record<string, unknown>;
    pack?: "npm" | "pnpm";
    beforePack?: (packageRoot: string) => void;
    postinstall?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-package-tarball-test-"));
  try {
    const includeCodeModeWorker = options.includeCodeModeWorker ?? true;
    const includeCodeModeWorkerInInventory =
      options.includeCodeModeWorkerInInventory ?? includeCodeModeWorker;
    const controlUiFiles =
      options.includeControlUi === false
        ? {}
        : {
            "dist/control-ui/index.html": "<!doctype html><openclaw-app></openclaw-app>",
            "dist/control-ui/assets/app.js": "console.log('ok');\n",
          };
    const declaredFiles = Array.isArray(options.packageJson?.files)
      ? options.packageJson.files
      : [];
    const fixturePackageFiles = Array.isArray(options.packageJson?.files)
      ? [
          ...(options.includeWorkspaceTemplates === false ? [] : ["docs/reference/templates/**"]),
          ...(options.includeLifecycleMarker === false
            ? []
            : [
                PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
                PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH,
              ]),
          ...declaredFiles,
        ]
      : undefined;
    const packageInventory = [
      ...new Set([
        ...inventory,
        ...(options.postinstall ? Object.keys(controlUiFiles) : []),
        ...(includeCodeModeWorkerInInventory ? [CODE_MODE_WORKER_PATH] : []),
      ]),
    ];
    const packageRoot = join(root, "package");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version,
        ...(options.postinstall
          ? { scripts: { postinstall: "node scripts/postinstall-bundled-plugins.mjs" } }
          : {}),
        ...options.packageJson,
        ...(fixturePackageFiles ? { files: fixturePackageFiles } : {}),
      }),
    );
    if (options.inventoryBody !== null) {
      writeFileSync(
        join(packageRoot, "dist", "postinstall-inventory.json"),
        options.inventoryBody ?? JSON.stringify(packageInventory),
      );
    }
    const workspaceTemplates =
      options.includeWorkspaceTemplates === false
        ? {}
        : Object.fromEntries(
            WORKSPACE_TEMPLATE_PACK_PATHS.map((relativePath) => [
              relativePath,
              `# ${relativePath}\n`,
            ]),
          );
    const lifecycleMarkerFile =
      options.includeLifecycleMarker === false
        ? {}
        : {
            [PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH]: "pending\n",
            [PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH]: "export {};\n",
          };
    const shrinkwrapFile =
      (options.includeShrinkwrap ?? declaredFiles.includes("npm-shrinkwrap.json"))
        ? {
            "npm-shrinkwrap.json": `${JSON.stringify({
              name: "openclaw",
              version,
              lockfileVersion: 3,
              packages: { "": { name: "openclaw", version } },
            })}\n`,
          }
        : {};
    const tarFiles = {
      ...workspaceTemplates,
      ...controlUiFiles,
      ...lifecycleMarkerFile,
      ...shrinkwrapFile,
      ...(includeCodeModeWorker ? { [CODE_MODE_WORKER_PATH]: "export {};\n" } : {}),
      ...files,
    };
    for (const [relativePath, body] of Object.entries(tarFiles)) {
      const filePath = join(packageRoot, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, body);
    }
    for (const relativePath of options.emptyDirectories ?? []) {
      mkdirSync(join(packageRoot, relativePath), { recursive: true });
    }
    options.beforePack?.(packageRoot);
    // The tarball mode gate requires world-readable entries; pin the fixture
    // against restrictive host umasks the way the packer normalizes artifacts.
    chmodTreeWorldReadable(packageRoot);

    const tarball = options.pack
      ? join(root, `openclaw-${version}.tgz`)
      : join(root, process.platform === "win32" ? "openclaw.tgz" : "openclaw:local.tgz");
    const packRunner =
      options.pack === "pnpm"
        ? {
            ...resolvePnpmRunner({
              cwd: packageRoot,
              pnpmArgs: [
                "pack",
                "--config.ignore-scripts=true",
                "--config.node-linker=hoisted",
                "--pack-destination",
                root,
              ],
            }),
            env: process.env,
          }
        : options.pack === "npm"
          ? resolveNpmRunner({
              npmArgs: ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
            })
          : undefined;
    const pack = packRunner
      ? spawnSync(packRunner.command, packRunner.args, {
          cwd: packageRoot,
          encoding: "utf8",
          env: packRunner.env,
          shell: packRunner.shell,
          timeout: 30_000,
          windowsVerbatimArguments: packRunner.windowsVerbatimArguments,
        })
      : spawnSync(
          "tar",
          [
            "-czf",
            `./${basename(tarball)}`,
            ...(options.filesOnlyArchive
              ? listFilesRecursively(packageRoot).map(
                  (relativePath) => `package/${relativePath.replaceAll("\\", "/")}`,
                )
              : ["package"]),
          ],
          {
            cwd: root,
            encoding: "utf8",
            env: { ...process.env, COPYFILE_DISABLE: "1" },
          },
        );
    expect(pack.status, pack.stderr || pack.error?.message).toBe(0);
    testBody(tarball, root, packageRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
