import path from "node:path";

function isPathUnderRoot(targetPath: string, rootPath: string): boolean {
  const normalizedTarget = path.resolve(targetPath);
  const normalizedRoot = path.resolve(rootPath);
  const rootToken = path.parse(normalizedRoot).root;
  if (normalizedRoot === rootToken) {
    return normalizedTarget.startsWith(rootToken);
  }
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

export function detectOpenClawTestStateDir(
  stateDir: string,
  deps?: {
    homedir?: string;
    resolveRealPath?: (targetPath: string) => string | null;
  },
): { path: string; root: string } | null {
  const resolvedPath = (deps?.resolveRealPath?.(stateDir) ?? stateDir).trim();
  if (!resolvedPath) {
    return null;
  }

  const candidate = path.resolve(resolvedPath);
  const explicitRoot = deps?.homedir ? path.join(deps.homedir, ".openclaw-tests") : null;
  if (explicitRoot && isPathUnderRoot(candidate, explicitRoot)) {
    return { path: candidate, root: path.resolve(explicitRoot) };
  }

  const testStateToken = `${path.sep}.openclaw-tests${path.sep}`;
  if (candidate.includes(testStateToken) || candidate.endsWith(`${path.sep}.openclaw-tests`)) {
    const prefix = candidate.split(`${path.sep}.openclaw-tests`)[0] || path.parse(candidate).root;
    return {
      path: candidate,
      root: path.resolve(prefix, ".openclaw-tests"),
    };
  }

  return null;
}
