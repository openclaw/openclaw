// systemd 239's format_cmdline counts arrays and flattens structs. This adapter
// only accepts the effective-command reader's signatures, not arbitrary D-Bus.
const MAX_BYTES = 1024 * 1024;
const MAX_VALUES = 16_384;
const SIGNATURES = new Set(["s", "o", "u", "b", "as", "a(sb)", "a(sasbttttuii)"]);
const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  "\\": 92,
  '"': 34,
  "'": 39,
};

function invalid(): never {
  throw new Error("Invalid legacy busctl output");
}

export function decodeLegacyBusctlOutput(
  stdout: string,
  signatures: string[],
  methodReply: boolean,
): unknown[] {
  if (
    Buffer.byteLength(stdout) > MAX_BYTES ||
    signatures.length === 0 ||
    signatures.length > MAX_VALUES
  ) {
    return invalid();
  }
  const lines = stdout.replace(/\r?\n$/, "").split(/\r?\n/);
  if (lines.length !== signatures.length) {
    return invalid();
  }
  let remaining = MAX_VALUES;
  const consume = () => {
    if (--remaining < 0) {
      invalid();
    }
  };
  return lines.map((line, index) => {
    const signature = signatures[index];
    if (!signature || !SIGNATURES.has(signature) || !line.startsWith(`${signature} `)) {
      return invalid();
    }
    let offset = signature.length;
    const token = (quoted: boolean): string => {
      if (line[offset++] !== " ") {
        return invalid();
      }
      if (!quoted) {
        const start = offset;
        while (offset < line.length && line[offset] !== " ") {
          offset++;
        }
        return line.slice(start, offset);
      }
      if (line[offset++] !== '"') {
        return invalid();
      }
      const bytes: number[] = [];
      while (offset < line.length) {
        const char = line.charAt(offset++);
        if (char === '"') {
          if (bytes.includes(0)) {
            return invalid();
          }
          // Octal escapes encode UTF-8 bytes, not individual Unicode characters.
          // Preserve a leading BOM just as the native reader/JSON do.
          return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            Uint8Array.from(bytes),
          );
        }
        if (char === "\\") {
          const escape = line[offset++];
          if (escape === undefined) {
            return invalid();
          }
          const escapedByte = Object.hasOwn(ESCAPES, escape) ? ESCAPES[escape] : undefined;
          if (escapedByte !== undefined) {
            bytes.push(escapedByte);
          } else {
            const octal = line.slice(offset - 1, offset + 2);
            if (!/^[0-3][0-7]{2}$/.test(octal)) {
              return invalid();
            }
            bytes.push(Number.parseInt(octal, 8));
            offset += 2;
          }
        } else {
          const byte = char.charCodeAt(0);
          // cescape emits every non-ASCII/control byte as an escape.
          if (byte < 32 || byte >= 127) {
            return invalid();
          }
          bytes.push(byte);
        }
      }
      return invalid();
    };
    const integer = (type: string): number => {
      const raw = token(false);
      if (!/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(raw) || raw.length > 20) {
        return invalid();
      }
      const value = BigInt(raw);
      const min = type === "i" ? -2147483648n : 0n;
      const max = type === "i" ? 2147483647n : type === "t" ? 18446744073709551615n : 4294967295n;
      if (value < min || value > max) {
        return invalid();
      }
      // Match the numeric representation of the JSON and native readers.
      return Number(value);
    };
    const read = (type: string): unknown => {
      consume();
      if (type.startsWith("a")) {
        const count = integer("u");
        if (count > remaining) {
          return invalid();
        }
        return Array.from({ length: count }, () => read(type.slice(1)));
      }
      if (type === "(sb)") {
        return [read("s"), read("b")];
      }
      if (type === "(sasbttttuii)") {
        return ["s", "as", "b", "t", "t", "t", "t", "u", "i", "i"].map(read);
      }
      if (type === "s" || type === "o") {
        const value = token(true);
        if (type === "o" && !/^(?:\/|(?:\/[A-Za-z0-9_]+)+)$/.test(value)) {
          return invalid();
        }
        return value;
      }
      if (type === "b") {
        const value = token(false);
        if (value !== "true" && value !== "false") {
          return invalid();
        }
        return value === "true";
      }
      if (type === "u" || type === "i" || type === "t") {
        return integer(type);
      }
      return invalid();
    };
    const value = read(signature);
    if (offset !== line.length) {
      return invalid();
    }
    return methodReply ? [value] : value;
  });
}
