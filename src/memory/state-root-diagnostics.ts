import path from "node:path";

const OPENCLAW_DIRNAME = ".openclaw";

export type NestedOpenClawStateRootDiagnostic = {
  dbPath: string;
  stateDir: string;
  expectedDbPath: string;
  outerStateDir: string;
  reason: "nested-db-path" | "nested-state-dir";
};

function normalizeFsPath(value: string): string {
  return path.resolve(value);
}

function findAncestorOpenClawDir(dir: string): string | null {
  let current = normalizeFsPath(dir);
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    if (path.basename(parent) === OPENCLAW_DIRNAME) {
      return parent;
    }
    current = parent;
  }
}

export function detectNestedOpenClawStateRoot(params: {
  dbPath: string;
  stateDir: string;
}): NestedOpenClawStateRootDiagnostic | null {
  const dbPath = normalizeFsPath(params.dbPath);
  const stateDir = normalizeFsPath(params.stateDir);
  const nestedToken = `${path.sep}${OPENCLAW_DIRNAME}${path.sep}${OPENCLAW_DIRNAME}${path.sep}`;

  if (dbPath.includes(nestedToken)) {
    const expectedDbPath = dbPath.replace(nestedToken, `${path.sep}${OPENCLAW_DIRNAME}${path.sep}`);
    return {
      dbPath,
      stateDir,
      expectedDbPath,
      outerStateDir: path.dirname(path.dirname(expectedDbPath)),
      reason: "nested-db-path",
    };
  }

  const outerStateDir = findAncestorOpenClawDir(stateDir);
  if (!outerStateDir) {
    return null;
  }

  return {
    dbPath,
    stateDir,
    expectedDbPath: path.join(outerStateDir, "memory", path.basename(dbPath)),
    outerStateDir,
    reason: "nested-state-dir",
  };
}

export function formatNestedOpenClawStateRootWarning(
  diagnostic: NestedOpenClawStateRootDiagnostic,
): string {
  return [
    `WARNING: state root appears to be nested inside another .openclaw dir (${diagnostic.dbPath}).`,
    "This usually means HOME, OPENCLAW_HOME, or OPENCLAW_STATE_DIR is misconfigured.",
    `Expected: ${diagnostic.expectedDbPath}`,
    `Got: ${diagnostic.dbPath}`,
    "Memory search will return zero results until this is corrected.",
  ].join("\n");
}
