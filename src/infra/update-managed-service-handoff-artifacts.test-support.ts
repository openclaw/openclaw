import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import { MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX } from "./update-managed-service-handoff-cleanup.js";

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function createManagedHandoffTempDirTracker() {
  const roots = [path.resolve(os.tmpdir()), realpathSync(os.tmpdir())];
  const dirs = new Set<string>();

  // Bun prepends runtime args to the helper argv; a positional dirname once resolved to "." and removed the checkout.
  function assertSafe(dir: string): void {
    const resolved = path.resolve(dir);
    const cwd = process.cwd();
    if (
      !path.isAbsolute(dir) ||
      !roots.some((root) => isInside(root, resolved)) ||
      resolved === cwd ||
      isInside(resolved, cwd)
    ) {
      throw new Error(`Refusing managed handoff test cleanup path: ${JSON.stringify(dir)}`);
    }
  }

  function add(dir: string): void {
    assertSafe(dir);
    dirs.add(dir);
  }

  return {
    get dirs(): ReadonlySet<string> {
      return new Set(dirs);
    },
    add,
    make(prefix: string): string {
      const dir = makeTempDir([], prefix);
      add(dir);
      return dir;
    },
    async cleanup(): Promise<void> {
      for (const dir of dirs) {
        assertSafe(dir);
        await fs.rm(dir, { recursive: true, force: true });
        dirs.delete(dir);
      }
    },
  };
}

export type ManagedHandoffTempDirTracker = ReturnType<typeof createManagedHandoffTempDirTracker>;

export function readManagedHandoffArtifacts(args: readonly string[]) {
  const scriptPath = args.at(-2);
  const paramsPath = args.at(-1);
  if (
    !scriptPath ||
    !paramsPath ||
    !path.isAbsolute(scriptPath) ||
    !path.isAbsolute(paramsPath) ||
    path.basename(scriptPath) !== "handoff.cjs" ||
    path.basename(paramsPath) !== "handoff.json" ||
    path.dirname(scriptPath) !== path.dirname(paramsPath) ||
    !path.basename(path.dirname(scriptPath)).startsWith(MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX)
  ) {
    throw new Error(`Invalid managed handoff artifact arguments: ${JSON.stringify(args)}`);
  }
  return { dir: path.dirname(scriptPath), scriptPath, paramsPath };
}
