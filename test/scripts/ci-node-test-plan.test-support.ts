import { globSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { toRepoPath } from "../../src/test-utils/repo-files.js";

type VitestConfig = {
  test?: { dir?: string; exclude?: string[]; include?: string[] };
};

export function listMatchedTestFiles(config: VitestConfig): string[] {
  const testConfig = config.test ?? {};
  const cwd = testConfig.dir ? resolve(testConfig.dir) : process.cwd();
  const exclude = (testConfig.exclude ?? []).map((pattern) =>
    isAbsolute(pattern) ? toRepoPath(relative(cwd, pattern)) : toRepoPath(pattern),
  );
  // Prune globs during discovery; compare literal unit-fast exclusions afterward.
  const exactFiles = new Set(exclude.filter((pattern) => /^[\w/.-]+\.test\.ts$/u.test(pattern)));
  return globSync(testConfig.include ?? [], {
    cwd,
    exclude: exclude.filter((pattern) => !exactFiles.has(pattern)),
  })
    .filter((file) => !exactFiles.has(toRepoPath(relative(cwd, resolve(cwd, file)))))
    .map((file) => toRepoPath(relative(process.cwd(), resolve(cwd, file))))
    .toSorted((a, b) => a.localeCompare(b));
}
