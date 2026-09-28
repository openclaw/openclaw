import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let readCloneId: ((filePath: string) => bigint) | undefined;

/** APFS clone IDs identify shared data streams, unlike inode numbers or du. */
export function getApfsCloneId(filePath: string): bigint {
  if (!readCloneId) {
    const koffi: typeof import("koffi").default = require("koffi");
    const libc = koffi.load("/usr/lib/libSystem.B.dylib");
    const getattrlist = libc.func(
      "int getattrlist(const char *path, const void *attributes, void *result, size_t size, unsigned long options)",
    );
    const attributes = Buffer.alloc(24);
    attributes.writeUInt16LE(5, 0); // ATTR_BIT_MAP_COUNT
    attributes.writeUInt32LE(0x80000000, 4); // ATTR_CMN_RETURNED_ATTRS
    attributes.writeUInt32LE(0x100, 20); // ATTR_CMNEXT_CLONEID
    readCloneId = (target) => {
      const result = Buffer.alloc(32);
      if (getattrlist(target, attributes, result, result.length, 0x20) !== 0) {
        throw new Error(`getattrlist clone ID failed (errno ${koffi.errno()}): ${target}`);
      }
      if (result.readUInt32LE(0) !== 32 || (result.readUInt32LE(20) & 0x100) === 0) {
        throw new Error(`Filesystem did not return an APFS clone ID: ${target}`);
      }
      return result.readBigUInt64LE(24);
    };
  }
  return readCloneId(filePath);
}
