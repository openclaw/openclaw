/** ClaWorks fork pruned zalo/zalouser — keep empty so tests do not target removed dirs. */
export const zaloExtensionTestRoots = [];

export function isZaloExtensionRoot(root) {
  return zaloExtensionTestRoots.includes(root);
}
