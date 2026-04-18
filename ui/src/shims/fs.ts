/**
 * Minimal browser shim for `node:fs` / `fs`.
 * Only `existsSync` is reached by leaked server code in the browser bundle.
 */

function existsSync(_path: string): boolean {
  return false;
}

function readFileSync(_path: string, _encoding?: string): string {
  return "";
}

function realpathSync(p: string): string {
  return p;
}

function statSync(_p: string): { isFile(): boolean; isDirectory(): boolean } {
  return { isFile: () => false, isDirectory: () => false };
}

export default { existsSync, readFileSync, realpathSync, statSync };
export { existsSync, readFileSync, realpathSync, statSync };
