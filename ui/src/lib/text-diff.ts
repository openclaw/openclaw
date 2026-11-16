/** Callers bound input sizes; both line and inline diffs use deletion-first LCS ties. */
export function visitTextDiff(
  oldLines: readonly string[],
  newLines: readonly string[],
  visit: (kind: "ctx" | "del" | "add", text: string) => void,
): void {
  const stride = newLines.length + 1;
  // The extra row/column are zero sentinels; bounded LCS lengths fit in Uint16.
  const lcs = new Uint16Array((oldLines.length + 1) * stride);
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      const offset = i * stride + j;
      lcs[offset] =
        oldLines[i] === newLines[j]
          ? lcs[offset + stride + 1]! + 1
          : Math.max(lcs[offset + stride]!, lcs[offset + 1]!);
    }
  }
  for (let i = 0, j = 0; i < oldLines.length || j < newLines.length;) {
    const oldLine = oldLines[i];
    const newLine = newLines[j];
    if (oldLine !== undefined && oldLine === newLine) {
      visit("ctx", oldLine);
      i++;
      j++;
    } else if (
      oldLine !== undefined &&
      (newLine === undefined || lcs[(i + 1) * stride + j]! >= lcs[i * stride + j + 1]!)
    ) {
      visit("del", oldLine);
      i++;
    } else if (newLine !== undefined) {
      visit("add", newLine);
      j++;
    }
  }
}
