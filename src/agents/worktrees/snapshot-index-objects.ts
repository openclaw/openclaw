import { createHash } from "node:crypto";

/** gitformat-index(5): raw index bytes do not themselves retain embedded Git objects. */
export function exactIndexObjects(data: Buffer, hashSize: 20 | 32): Map<string, "blob" | "tree"> {
  const end = data.length - hashSize;
  const invalid = () => new Error("Unsupported or invalid exact-state index; source preserved");
  if (
    end < 12 ||
    data.toString("ascii", 0, 4) !== "DIRC" ||
    ![2, 3, 4].includes(data.readUInt32BE(4)) ||
    !createHash(hashSize === 20 ? "sha1" : "sha256")
      .update(data.subarray(0, end))
      .digest()
      .equals(data.subarray(end))
  ) {
    throw invalid();
  }
  const objects = new Map<string, "blob" | "tree">();
  const add = (offset: number, limit: number, kind: "blob" | "tree") => {
    if (offset + hashSize > limit) {
      throw invalid();
    }
    const object = data.subarray(offset, offset + hashSize).toString("hex");
    if (!/^0+$/u.test(object)) {
      objects.set(object, kind);
    }
  };
  const nul = (offset: number, limit: number) => {
    const result = data.indexOf(0, offset);
    if (result < offset || result >= limit) {
      throw invalid();
    }
    return result;
  };
  let offset = 12;
  for (let entry = 0; entry < data.readUInt32BE(8); entry++) {
    const start = offset;
    offset += 42 + hashSize;
    if (offset > end) {
      throw invalid();
    }
    const mode = data.readUInt32BE(start + 24);
    if ((mode & 0o170000) === 0o160000) {
      throw new Error("Nested Git index objects cannot be snapshotted losslessly");
    }
    add(start + 40, end, (mode & 0o170000) === 0o040000 ? "tree" : "blob");
    if (data.readUInt16BE(offset - 2) & 0x4000) {
      offset += 2;
    }
    if (data.readUInt32BE(4) === 4) {
      // The v4 pathname prefix is a bounded variable-length integer; only its
      // encoded length matters when finding the following NUL-terminated suffix.
      let bytes = 0;
      do {
        if (offset >= end || ++bytes > 10) {
          throw invalid();
        }
      } while (data[offset++]! & 0x80);
      offset = nul(offset, end) + 1;
    } else {
      offset = start + Math.ceil((nul(offset, end) + 1 - start) / 8) * 8;
    }
    if (offset > end) {
      throw invalid();
    }
  }
  while (offset < end) {
    if (offset + 8 > end) {
      throw invalid();
    }
    const signature = data.toString("ascii", offset, offset + 4);
    const limit = offset + 8 + data.readUInt32BE(offset + 4);
    offset += 8;
    if (limit > end) {
      throw invalid();
    }
    if (signature === "TREE") {
      while (offset < limit) {
        offset = nul(offset, limit) + 1;
        const newline = data.indexOf(10, offset);
        if (newline < offset || newline >= limit) {
          throw invalid();
        }
        const counts = /^(-?\d+) (\d+)$/u.exec(data.toString("ascii", offset, newline));
        if (!counts) {
          throw invalid();
        }
        offset = newline + 1;
        if (Number(counts[1]) >= 0) {
          add(offset, limit, "tree");
          offset += hashSize;
        }
      }
    } else if (signature === "REUC") {
      while (offset < limit) {
        offset = nul(offset, limit) + 1;
        const modes: number[] = [];
        for (let stage = 0; stage < 3; stage++) {
          const next = nul(offset, limit);
          const raw = data.toString("ascii", offset, next);
          if (!/^[0-7]+$/u.test(raw)) {
            throw invalid();
          }
          modes.push(Number.parseInt(raw, 8));
          offset = next + 1;
        }
        for (const mode of modes) {
          if (mode === 0) {
            continue;
          }
          if ((mode & 0o170000) === 0o160000) {
            throw new Error("Nested Git resolve-undo objects cannot be snapshotted losslessly");
          }
          add(offset, limit, "blob");
          offset += hashSize;
        }
      }
    } else if (!["link", "UNTR", "FSMN", "EOIE", "IEOT"].includes(signature)) {
      // Unknown optional extensions may carry object dependencies too. Ordinary
      // Git can ignore them, but byte-exact recovery must not silently drop them.
      throw new Error(`Unsupported exact-state index extension ${signature}; source preserved`);
    }
    offset = limit;
  }
  return objects;
}
