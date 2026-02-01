const NODE_VERSIONED_PATTERN = /^node-?\d+(?:\.\d+)*(?:\.exe)?$/;

function getBasename(execPath: string): string {
  const trimmed = execPath.trim().replace(/^["']|["']$/g, "");
  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

export function isNodeRuntime(execPath: string): boolean {
  const base = getBasename(execPath).toLowerCase();
  return (
    base === "node" ||
    base === "node.exe" ||
    base === "nodejs" ||
    base === "nodejs.exe" ||
    NODE_VERSIONED_PATTERN.test(base)
  );
}

export function isBunRuntime(execPath: string): boolean {
  const base = getBasename(execPath).toLowerCase();
  return base === "bun" || base === "bun.exe";
}
