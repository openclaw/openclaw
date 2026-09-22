import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
type PrivatePathCreators = {
  directory: (directoryPath: string) => void;
  file: (filePath: string) => number;
};
let creators: PrivatePathCreators | undefined;

function loadPrivatePathCreators(): PrivatePathCreators {
  const koffi: typeof import("koffi").default = require("koffi");
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");
  const attributes = koffi.struct({
    length: "uint32_t",
    descriptor: "void *",
    inheritHandle: "int32_t",
  });
  const getLastError = kernel32.func("uint32_t __stdcall GetLastError()");
  const getCurrentProcess = kernel32.func("void * __stdcall GetCurrentProcess()");
  const closeHandle = kernel32.func("int32_t __stdcall CloseHandle(void *handle)");
  const localFree = kernel32.func("void * __stdcall LocalFree(void *memory)");
  const openToken = advapi32.func(
    "int32_t __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
  );
  const getTokenInformation = advapi32.func(
    "int32_t __stdcall GetTokenInformation(void *token, int32_t informationClass, _Out_ void *information, uint32_t length, _Out_ uint32_t *required)",
  );
  const convertSid = advapi32.func(
    "int32_t __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)",
  );
  const convertDescriptor = advapi32.func(
    "int32_t __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t revision, _Out_ void **descriptor, void *size)",
  );
  const createDirectory = kernel32.func("__stdcall", "CreateDirectoryW", "int32_t", [
    "str16",
    koffi.pointer(attributes),
  ]);
  const createFile = kernel32.func("__stdcall", "CreateFileW", "void *", [
    "str16",
    "uint32_t",
    "uint32_t",
    koffi.pointer(attributes),
    "uint32_t",
    "uint32_t",
    "void *",
  ]);
  const failure = (operation: string) => {
    const errorCode: number = getLastError();
    return Object.assign(new Error(`${operation} failed (Win32 error ${errorCode})`), {
      code: errorCode === 80 || errorCode === 183 ? "EEXIST" : "EIO",
      errno: errorCode,
    });
  };

  const withPrivateAttributes = <T>(
    inherit: boolean,
    operation: (security: {
      length: number;
      descriptor: bigint | null;
      inheritHandle: number;
    }) => T,
  ): T => {
    const token: [bigint | null] = [null];
    const sidText: [bigint | null] = [null];
    const descriptor: [bigint | null] = [null];
    // Read the primary token on each call; ownership belongs to the
    // creating process, not to a username or an environment-provided SID.
    if (!openToken(getCurrentProcess(), 0x0008, token)) {
      throw failure("OpenProcessToken");
    }
    try {
      const required: [number] = [0];
      getTokenInformation(token[0], 1, null, 0, required);
      if (getLastError() !== 122 || required[0] === 0) {
        throw failure("GetTokenInformation(size)");
      }
      const user = Buffer.alloc(required[0]);
      if (!getTokenInformation(token[0], 1, user, user.length, required)) {
        throw failure("GetTokenInformation");
      }
      // TOKEN_USER begins with SID_AND_ATTRIBUTES, whose first field is PSID.
      if (!convertSid(koffi.decode(user, "void *"), sidText)) {
        throw failure("ConvertSidToStringSidW");
      }
      const sid: string = koffi.decode(sidText[0], "char16_t", -1);
      const flags = inherit ? "OICI" : "";
      const sddl = `O:${sid}D:P(A;${flags};FA;;;${sid})(A;${flags};FA;;;SY)(A;${flags};FA;;;BA)`;
      if (!convertDescriptor(sddl, 1, descriptor, null)) {
        throw failure("ConvertStringSecurityDescriptorToSecurityDescriptorW");
      }
      return operation({
        length: koffi.sizeof(attributes),
        descriptor: descriptor[0],
        inheritHandle: 0,
      });
    } finally {
      if (descriptor[0] !== null) {
        localFree(descriptor[0]);
      }
      if (sidText[0] !== null) {
        localFree(sidText[0]);
      }
      closeHandle(token[0]);
    }
  };
  return {
    directory: (directoryPath) =>
      withPrivateAttributes(true, (security) => {
        if (!createDirectory(path.toNamespacedPath(path.resolve(directoryPath)), security)) {
          throw failure(`CreateDirectoryW(${directoryPath})`);
        }
      }),
    file: (filePath) =>
      withPrivateAttributes(false, (security) => {
        const resolved = path.toNamespacedPath(path.resolve(filePath));
        // CREATE_NEW applies the protected DACL before the file becomes visible.
        const handle = createFile(resolved, 0xc0000000, 0x3, security, 1, 0x80, null);
        if (handle === null || BigInt.asIntN(64, koffi.address(handle)) === -1n) {
          throw failure(`CreateFileW(${filePath})`);
        }
        try {
          // READ/WRITE sharing permits this Node fd; withholding DELETE pins the name until open.
          return fs.openSync(resolved, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
        } finally {
          closeHandle(handle);
        }
      }),
  };
}

export function createPrivateWindowsDirectory(directoryPath: string): void {
  creators ??= loadPrivatePathCreators();
  creators.directory(directoryPath);
}

export function createPrivateWindowsFile(filePath: string): number {
  creators ??= loadPrivatePathCreators();
  return creators.file(filePath);
}
