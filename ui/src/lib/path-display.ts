/** Last nonempty segment for either path separator; preserves filesystem roots. */
export function pathDisplayName(path: string): string {
  return path.split(/[\\/]/).findLast(Boolean) ?? path;
}
