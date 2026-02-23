import path from "node:path";

export function isNodeRuntime(execPath: string): boolean {
  const base = path.basename(execPath).toLowerCase();
  return base === "node" || base === "node.exe";
}

export function isBunRuntime(execPath: string): boolean {
  const base = path.basename(execPath).toLowerCase();
  return base === "bun" || base === "bun.exe";
}
