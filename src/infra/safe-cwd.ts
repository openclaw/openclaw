// Safe process.cwd() helpers for launch paths that may run after the invoking
// directory has been deleted (e.g. `git clean`, rmdir by another process).
//
// `process.cwd()` throws `ENOENT: ... uv_cwd` in that case. Rather than baking
// one generic fallback into a shared helper, each caller decides what a missing
// cwd means for it:
//   - dotenv loading: skip workspace `.env` (it cannot exist) — see tryProcessCwd
//   - PATH bootstrap: skip project-local bin lookup — see tryProcessCwd
//   - home-dir / TUI / local shell: fall back to a caller-chosen directory —
//     see resolveProcessCwdOrFallback
// A generic HOME fallback is intentionally NOT provided here: mapping a deleted
// project cwd to $HOME would let $HOME/node_modules/.bin participate in
// project-local PATH trust semantics (cf. PR #74994 review).

/** Returns process.cwd(), or null when the working directory has been deleted. */
export function tryProcessCwd(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

/** Returns process.cwd(), or `fallback` when the working directory has been deleted. */
export function resolveProcessCwdOrFallback(fallback: string): string {
  return tryProcessCwd() ?? fallback;
}
