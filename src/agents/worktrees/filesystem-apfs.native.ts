import koffi from "koffi";

const libc = koffi.load("/usr/lib/libSystem.B.dylib");
const getattrlist = libc.func(
  "int getattrlist(const char *path, const void *attributes, void *result, size_t size, unsigned long options)",
);
const aclGetFile = libc.func("void *acl_get_file(const char *path, int type)");
const aclGetEntry = libc.func("int acl_get_entry(void *acl, int entryId, _Out_ void **entry)");
const aclGetFlagset = libc.func("int acl_get_flagset_np(void *entry, _Out_ void **flags)");
const aclGetFlag = libc.func("int acl_get_flag_np(void *flags, uint32_t flag)");
const aclFree = libc.func("int acl_free(void *acl)");
const aclAttributes = Buffer.alloc(24);
aclAttributes.writeUInt16LE(5, 0); // ATTR_BIT_MAP_COUNT
aclAttributes.writeUInt32LE(0x00400000, 4); // ATTR_CMN_EXTENDED_SECURITY
export const apfsFilesystem = {
  readDirectoryAcl(
    this: void,
    directory: string,
  ): "none" | "non-inheritable" | "inheritable" | undefined {
    // acl_get_file reports ENOENT for both absent ACLs and absent paths. This
    // attribute header distinguishes an empty ACL from a failed read without
    // decoding the opaque security blob (FSOPT_NOFOLLOW | FSOPT_REPORT_FULLSIZE).
    const result = Buffer.alloc(12);
    if (getattrlist(directory, aclAttributes, result, result.length, 0x0001 | 0x0004) !== 0) {
      return undefined;
    }
    const length = result.readUInt32LE(0);
    const size = result.readUInt32LE(8);
    if (length < result.length || size > length - result.length) {
      return undefined;
    }
    if (size === 0) {
      return length === result.length ? "none" : undefined;
    }
    // Let libc own ACL decoding and storage. A changed/failed second read is
    // unknown, including ENOENT; only the successful empty header proves no ACL.
    const acl = aclGetFile(directory, 0x100); // ACL_TYPE_EXTENDED
    if (!acl) {
      return undefined;
    }
    try {
      const entry: unknown[] = [null];
      const flags: unknown[] = [null];
      for (let selection = 0; ; selection = -1) {
        // ACL_FIRST_ENTRY / ACL_NEXT_ENTRY
        const code = aclGetEntry(acl, selection, entry);
        if (code !== 0) {
          // Darwin returns -1/EINVAL at exhaustion, unlike POSIX/Linux's 0.
          return code === -1 && koffi.errno() === 22 ? "non-inheritable" : undefined;
        }
        if (aclGetFlagset(entry[0], flags) !== 0) {
          return undefined;
        }
        const files = aclGetFlag(flags[0], 0x20); // ACL_ENTRY_FILE_INHERIT
        const directories = aclGetFlag(flags[0], 0x40); // ACL_ENTRY_DIRECTORY_INHERIT
        if ((files !== 0 && files !== 1) || (directories !== 0 && directories !== 1)) {
          return undefined;
        }
        if (files === 1 || directories === 1) {
          return "inheritable";
        }
      }
    } finally {
      aclFree(acl);
    }
  },
};
