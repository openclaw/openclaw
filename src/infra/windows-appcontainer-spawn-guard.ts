import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TOKEN_IS_APP_CONTAINER = 29;
let insideAppContainer: boolean | undefined;

function readIsAppContainer(): boolean {
  const koffi: typeof import("koffi").default = require("koffi");
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");
  const getCurrentProcess = kernel32.func("void * __stdcall GetCurrentProcess()");
  const closeHandle = kernel32.func("int32_t __stdcall CloseHandle(void *handle)");
  const openToken = advapi32.func(
    "int32_t __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
  );
  const getTokenInformation = advapi32.func(
    "int32_t __stdcall GetTokenInformation(void *token, int32_t informationClass, _Out_ void *information, uint32_t length, _Out_ uint32_t *required)",
  );
  const token: [bigint | null] = [null];
  if (!openToken(getCurrentProcess(), 0x0008, token)) {
    throw new Error("Could not check for a Windows AppContainer: OpenProcessToken failed.");
  }
  try {
    const value = Buffer.alloc(4);
    const required: [number] = [0];
    if (getTokenInformation(token[0], TOKEN_IS_APP_CONTAINER, value, value.length, required) === 0) {
      throw new Error("Could not check for a Windows AppContainer: GetTokenInformation failed.");
    }
    return value.readUInt32LE(0) !== 0;
  } finally {
    closeHandle(token[0]);
  }
}

function libuvBelow153(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  return major < 1 || (major === 1 && minor < 53);
}

/**
 * libuv < 1.53 retries child stdio/IPC pipe creation forever inside a Windows
 * AppContainer (libuv/libuv#5178), so fail before spawning instead of spinning.
 */
export function assertWindowsChildPipesSupported(
  params: {
    platform?: NodeJS.Platform;
    libuvVersion?: string;
    isAppContainer?: () => boolean;
  } = {},
): void {
  const { platform = process.platform, libuvVersion = process.versions.uv } = params;
  if (platform !== "win32" || !libuvVersion || !libuvBelow153(libuvVersion)) {
    return;
  }
  const inside = params.isAppContainer
    ? params.isAppContainer()
    : (insideAppContainer ??= readIsAppContainer());
  if (inside) {
    throw new Error(
      `This Node.js bundles libuv ${libuvVersion}, which cannot create child-process pipes inside a Windows AppContainer. libuv 1.53.0 or later is required.`,
    );
  }
}
