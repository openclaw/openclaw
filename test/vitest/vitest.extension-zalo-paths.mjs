// Test routing roots for Zalo extension tests.
export const zaloExtensionTestRoots = ["extensions/zalo"];

export function isZaloExtensionRoot(root) {
  return zaloExtensionTestRoots.includes(root);
}
