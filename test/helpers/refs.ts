import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
type FileExtent = { vcn: bigint; nextVcn: bigint; lcn: bigint };
let readExtents: ((filePath: string) => FileExtent[]) | undefined;

/** Compare physical mappings independently of the clone implementation. */
export function getRefsFileExtents(filePath: string): FileExtent[] {
  if (!readExtents) {
    const koffi: typeof import("koffi").default = require("koffi");
    const kernel32 = koffi.load("kernel32.dll");
    const createFile = kernel32.func(
      "intptr_t __stdcall CreateFileW(const char16_t *path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t attributes, void *templateFile)",
    );
    const closeHandle = kernel32.func("int __stdcall CloseHandle(intptr_t handle)");
    const getLastError = kernel32.func("uint32_t __stdcall GetLastError()");
    const deviceIoControl = kernel32.func(
      "int __stdcall DeviceIoControl(intptr_t handle, uint32_t code, const void *input, uint32_t inputSize, void *output, uint32_t outputSize, void *returned, void *overlapped)",
    );
    readExtents = (target) => {
      const handle = BigInt(createFile(path.toNamespacedPath(target), 0, 7, null, 3, 0, null));
      if (handle === -1n) {
        throw new Error(`CreateFileW failed (${getLastError()}): ${target}`);
      }
      try {
        const extents: FileExtent[] = [];
        const input = Buffer.alloc(8);
        const output = Buffer.alloc(64 * 1024);
        const returned = Buffer.alloc(4);
        for (;;) {
          // FSCTL_GET_RETRIEVAL_POINTERS maps VCNs to volume-relative LCNs.
          const success = deviceIoControl(
            handle,
            0x90073,
            input,
            input.length,
            output,
            output.length,
            returned,
            null,
          );
          const error = success ? 0 : getLastError();
          if (error === 38) {
            return extents; // ERROR_HANDLE_EOF: empty files have no extents.
          }
          if (!success && error !== 234) {
            throw new Error(`FSCTL_GET_RETRIEVAL_POINTERS failed (${error}): ${target}`);
          }
          const count = output.readUInt32LE(0);
          if (count === 0 || returned.readUInt32LE(0) < 16 + count * 16) {
            throw new Error(`Invalid file extent response: ${target}`);
          }
          let vcn = output.readBigInt64LE(8);
          for (let i = 0; i < count; i += 1) {
            const nextVcn = output.readBigInt64LE(16 + i * 16);
            extents.push({ vcn, nextVcn, lcn: output.readBigInt64LE(24 + i * 16) });
            vcn = nextVcn;
          }
          if (success) {
            return extents;
          }
          input.writeBigInt64LE(vcn);
        }
      } finally {
        closeHandle(handle);
      }
    };
  }
  return readExtents(filePath);
}
