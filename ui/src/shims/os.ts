/**
 * Minimal browser shim for `node:os` / `os`.
 * Only `homedir()` is actually called by code that leaks into the UI bundle.
 */

function homedir(): string {
  return "/";
}

function platform(): string {
  return "browser";
}

function tmpdir(): string {
  return "/tmp";
}

export default { homedir, platform, tmpdir };
export { homedir, platform, tmpdir };
