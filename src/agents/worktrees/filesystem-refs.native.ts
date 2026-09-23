import path from "node:path";
import koffi from "koffi";

const kernel32 = koffi.load("kernel32.dll");
const getLastError = kernel32.func("uint32_t __stdcall GetLastError()");
const getVolumePath = kernel32.func(
  "int32_t __stdcall GetVolumePathNameW(str16 path, _Out_ void *volume, uint32_t length)",
);
const getVolumeInformation = kernel32.func(
  "int32_t __stdcall GetVolumeInformationW(str16 root, void *label, uint32_t labelLength, void *serial, void *componentLength, _Out_ uint32_t *flags, _Out_ void *filesystem, uint32_t filesystemLength)",
);
const getDiskFreeSpace = kernel32.func(
  "int32_t __stdcall GetDiskFreeSpaceW(str16 root, _Out_ uint32_t *sectors, _Out_ uint32_t *bytes, _Out_ uint32_t *freeClusters, _Out_ uint32_t *clusters)",
);
const createFile = kernel32.func(
  "void * __stdcall CreateFileW(str16 path, uint32_t access, uint32_t sharing, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
);
const closeHandle = kernel32.func("int32_t __stdcall CloseHandle(void *handle)");
const getFileInformation = kernel32.func(
  "int32_t __stdcall GetFileInformationByHandle(void *handle, _Out_ void *information)",
);
const setFileInformation = kernel32.func(
  "int32_t __stdcall SetFileInformationByHandle(void *handle, int32_t informationClass, void *information, uint32_t size)",
);
const setFileTime = kernel32.func(
  "int32_t __stdcall SetFileTime(void *handle, void *created, void *accessed, void *written)",
);
const setFileAttributes = kernel32.func(
  "int32_t __stdcall SetFileAttributesW(str16 path, uint32_t attributes)",
);
const copyFile = kernel32.func(
  "int32_t __stdcall CopyFileExW(str16 source, str16 destination, void *progress, void *data, void *cancel, uint32_t flags)",
);
const deviceIoControl = kernel32.func(
  "int32_t __stdcall DeviceIoControl(void *handle, uint32_t code, void *input, uint32_t inputSize, _Out_ void *output, uint32_t outputSize, _Out_ uint32_t *returned, void *overlapped)",
);
const duplicateExtents = koffi.struct({
  file: "void *",
  sourceOffset: "int64_t",
  targetOffset: "int64_t",
  length: "int64_t",
});

function failure(operation: string): Error {
  const errno: number = getLastError();
  return Object.assign(new Error(`${operation} failed (Win32 error ${errno})`), {
    code: errno === 80 || errno === 183 ? "EEXIST" : "EIO",
    errno,
  });
}

function openFile(filePath: string, access: number, disposition: number, flags: number): unknown {
  const handle: unknown = createFile(filePath, access, 1, null, disposition, flags, null);
  if (handle === null || BigInt.asIntN(64, koffi.address(handle)) === -1n) {
    throw failure(`CreateFileW(${filePath})`);
  }
  return handle;
}

function control(handle: unknown, code: number, input: Buffer | null, output: Buffer | null) {
  if (
    !deviceIoControl(
      handle,
      code,
      input,
      input?.length ?? 0,
      output,
      output?.length ?? 0,
      [0],
      null,
    )
  ) {
    throw failure(`DeviceIoControl(0x${code.toString(16)})`);
  }
}

export const refsFilesystem = {
  probe(parentPath: string): { clusterSize: number } | null {
    // Resolve the containing volume, including volumes mounted under NTFS folders.
    const root = Buffer.alloc(32768 * 2);
    if (!getVolumePath(path.toNamespacedPath(path.resolve(parentPath)), root, root.length / 2)) {
      throw failure("GetVolumePathNameW");
    }
    const volume = root.toString("utf16le").split("\0", 1)[0];
    const filesystem = Buffer.alloc(64);
    const flags: [number] = [0];
    if (
      !getVolumeInformation(volume, null, 0, null, null, flags, filesystem, filesystem.length / 2)
    ) {
      throw failure("GetVolumeInformationW");
    }
    // FILE_SUPPORTS_BLOCK_REFCOUNTING is the filesystem's advertised clone capability.
    if (filesystem.toString("utf16le").split("\0", 1)[0] !== "ReFS" || !(flags[0] & 0x08000000)) {
      return null;
    }
    const sectors: [number] = [0];
    const bytes: [number] = [0];
    if (!getDiskFreeSpace(volume, sectors, bytes, [0], [0])) {
      throw failure("GetDiskFreeSpaceW");
    }
    return { clusterSize: sectors[0] * bytes[0] };
  },

  cloneFile(this: void, source: string, destination: string, clusterSize: number): void {
    const from = path.toNamespacedPath(path.resolve(source));
    const to = path.toNamespacedPath(path.resolve(destination));
    // OPEN_EXISTING, NO_BUFFERING | OPEN_REPARSE_POINT: never dereference a template link.
    const sourceHandle = openFile(from, 0x80000000, 3, 0x20200000);
    try {
      const information = Buffer.alloc(52); // BY_HANDLE_FILE_INFORMATION
      if (!getFileInformation(sourceHandle, information)) {
        throw failure("GetFileInformationByHandle");
      }
      const attributes = information.readUInt32LE(0);
      if (attributes & 0x400) {
        // COPY_FILE_FAIL_IF_EXISTS | COPY_FILE_COPY_SYMLINK copies the link itself.
        if (!copyFile(from, to, null, null, null, 0x801)) {
          throw failure("CopyFileExW(symlink)");
        }
        return;
      }
      // CREATE_NEW preserves existing destinations; ACLs inherit from the destination parent.
      const targetHandle = openFile(to, 0xc0000000, 1, 0x80);
      try {
        const integrity = Buffer.alloc(16);
        control(sourceHandle, 0x9027c, null, integrity); // FSCTL_GET_INTEGRITY_INFORMATION
        control(targetHandle, 0x9c280, integrity.subarray(0, 8), null); // FSCTL_SET_INTEGRITY_INFORMATION
        control(targetHandle, 0x900c4, null, null); // FSCTL_SET_SPARSE avoids allocating zeroes.
        const size =
          (BigInt(information.readUInt32LE(32)) << 32n) | BigInt(information.readUInt32LE(36));
        const eof = Buffer.alloc(8);
        eof.writeBigInt64LE(size);
        if (!setFileInformation(targetHandle, 6, eof, eof.length)) {
          // FileEndOfFileInfo
          throw failure("SetFileInformationByHandle(EOF)");
        }
        // ReFS accepts the final partial cluster past logical EOF. Keep the exact file size,
        // round only the clone range, and stay below the API's 4 GiB limit per operation.
        const cluster = BigInt(clusterSize);
        const roundedSize = ((size + cluster - 1n) / cluster) * cluster;
        const request = Buffer.alloc(koffi.sizeof(duplicateExtents));
        for (let offset = 0n; offset < size;) {
          const length = roundedSize - offset < 0x80000000n ? roundedSize - offset : 0x80000000n;
          koffi.encode(request, duplicateExtents, {
            file: sourceHandle,
            sourceOffset: offset,
            targetOffset: offset,
            length,
          });
          control(targetHandle, 0x98344, request, null); // FSCTL_DUPLICATE_EXTENTS_TO_FILE
          offset += length;
        }
        if (
          !setFileTime(
            targetHandle,
            information.subarray(4, 12),
            information.subarray(12, 20),
            information.subarray(20, 28),
          )
        ) {
          throw failure("SetFileTime");
        }
      } finally {
        closeHandle(targetHandle);
      }
      // Sparse/integrity flags belong to their FSCTL owners, not SetFileAttributesW.
      if (!setFileAttributes(to, attributes & 0x3127 || 0x80)) {
        throw failure("SetFileAttributesW");
      }
    } finally {
      closeHandle(sourceHandle);
    }
  },
};
