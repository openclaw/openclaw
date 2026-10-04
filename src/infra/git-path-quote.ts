const escapes = new Map([
  [97, 7],
  [98, 8],
  [102, 12],
  [110, 10],
  [114, 13],
  [116, 9],
  [118, 11],
  [34, 34],
  [92, 92],
]);

/** Git quote.c unquote_c_style: octal escapes encode bytes, not Unicode code points. */
export function unquoteGitPath(
  input: Buffer,
  start = 0,
): { bytes: Buffer; end: number } | undefined {
  if (input[start] !== 34) {
    return undefined;
  }
  const output: number[] = [];
  for (let index = start + 1; index < input.length; index++) {
    let byte = input[index]!;
    if (byte === 0) {
      return undefined;
    }
    if (byte === 34) {
      return { bytes: Buffer.from(output), end: index + 1 };
    }
    if (byte === 92) {
      const escaped = input[++index];
      if (escaped === undefined) {
        return undefined;
      }
      const decoded = escapes.get(escaped);
      if (decoded !== undefined) {
        byte = decoded;
      } else {
        const second = input[index + 1];
        const third = input[index + 2];
        if (
          escaped < 48 ||
          escaped > 51 ||
          second === undefined ||
          second < 48 ||
          second > 55 ||
          third === undefined ||
          third < 48 ||
          third > 55
        ) {
          return undefined;
        }
        byte = ((escaped - 48) << 6) | ((second - 48) << 3) | (third - 48);
        index += 2;
      }
    }
    output.push(byte);
  }
  return undefined;
}
