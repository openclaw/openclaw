// Fixture tree copy helper for trees whose files tests execute directly.
import fs from "node:fs";

/**
 * Clone a fixture tree without leaking writable descriptors into child processes.
 *
 * Without a filter, Node 24 copies directories through std::filesystem, which
 * ignores `mode` and opens copies without O_CLOEXEC. A sibling Vitest thread
 * that forks during the copy keeps the file writable, so a later execve of it
 * fails with ETXTBSY. The filter keeps new files on libuv's close-on-exec
 * copyFileSync; the clone mode does the same for overwritten files.
 */
export function copyTreeCloseOnExec(
  source: string,
  destination: string,
  options: { dereference?: boolean } = {},
): void {
  fs.cpSync(source, destination, {
    ...options,
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
    filter: () => true,
  });
}
