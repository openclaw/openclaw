import { fstatSync } from "node:fs";
import { isatty } from "node:tty";

/**
 * Releases inherited stdin before a child entry point disconnects.
 *
 * Node 26 closes fd 0 when destroying a stdin ReadStream over a regular file or
 * /dev/null (stdio "ignore"). libuv then hands fd 0 to the next worker loop and
 * aborts when that loop closes it. Such stdin holds no handle that keeps the
 * process alive, so it is left open; pipes, sockets and TTYs are still released.
 * Bun reports pipe stdin as a ReadStream too, so the fd type decides, not the class.
 */
export function releaseProcessStdin(): void {
  let fileBacked = false;
  try {
    const stat = fstatSync(0);
    fileBacked = stat.isFile() || (stat.isCharacterDevice() && !isatty(0));
  } catch {
    // An unreadable fd 0 keeps the previous release behavior.
  }
  if (!fileBacked) {
    process.stdin.destroy();
  }
}
