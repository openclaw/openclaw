export const diffsExtensionTestRoots = ["extensions/diffs"];

export function isDiffsExtensionRoot(root) {
  return diffsExtensionTestRoots.includes(root);
}
