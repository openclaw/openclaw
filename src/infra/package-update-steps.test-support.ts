import fs from "node:fs/promises";
import path from "node:path";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import type { PackageUpdateStepRunner } from "./package-update-lifecycle.js";
import type { CommandRunner } from "./update-global-command-runner.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";
import type { UpdateStepResult } from "./update-step-result.js";

export async function writePackageRoot(packageRoot: string, version: string): Promise<void> {
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
      "utf8",
    ),
    fs.writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n", "utf8"),
  ]);
  await writePackageDistInventory(packageRoot);
}

export function createNpmTarget(globalRoot: string): ResolvedGlobalInstallTarget {
  return {
    manager: "npm",
    command: "npm",
    globalRoot,
    packageRoot: path.join(globalRoot, "openclaw"),
    npmOwner: {
      version: "12.0.0",
      lifecyclePolicy: "allow-scripts",
    },
  };
}

export function createPnpmTarget(
  globalRoot: string,
  packageRoot: string,
): ResolvedGlobalInstallTarget {
  return {
    manager: "pnpm",
    command: "pnpm",
    pnpmIsolated: { layoutVersion: 11 },
    globalRoot,
    packageRoot,
  };
}

export function createNpmUpdateOptions(globalRoot: string, installSpec = "openclaw@2.0.0") {
  return {
    installTarget: createNpmTarget(globalRoot),
    installSpec,
    packageName: "openclaw",
    runCommand: createRootRunner(globalRoot),
    timeoutMs: 1000,
  };
}

export function stagedNpmPrefix(argv: string[]): string {
  const index = argv.indexOf("--prefix");
  const prefix = argv[index + 1];
  if (index < 0 || !prefix) {
    throw new Error("Expected a production-created staged npm prefix");
  }
  return prefix;
}

export function packageUpdateStepResult(
  { name, argv, cwd }: Pick<Parameters<PackageUpdateStepRunner>[0], "name" | "argv" | "cwd">,
  result: Partial<UpdateStepResult> = {},
): UpdateStepResult {
  return {
    name,
    command: argv.join(" "),
    cwd: cwd ?? process.cwd(),
    durationMs: 1,
    exitCode: 0,
    ...result,
  };
}

export function createRootRunner(globalRoot: string): CommandRunner {
  return async (argv) => {
    if (argv.join(" ") === "npm --version") {
      return { stdout: "12.0.0\n", stderr: "", code: 0 };
    }
    if (argv.join(" ") === "npm root -g") {
      return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };
}
