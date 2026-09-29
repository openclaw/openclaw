import { createRequire } from "node:module";
import process from "node:process";

/**
 * Inside a Windows AppContainer, named pipes must live under `\\.\pipe\LOCAL\`.
 * libuv below 1.53.0 names a child's stdio pipes outside it, so the pipe is
 * refused and the spawn never completes. libuv 1.53.0 fixed the name
 * (libuv/libuv#5181, "win: fix unique named pipes to work inside Windows
 * AppContainer").
 */
const APPCONTAINER_MIN_LIBUV = [1, 53, 0] as const;
export const APPCONTAINER_MIN_LIBUV_VERSION = APPCONTAINER_MIN_LIBUV.join(".");

export type AppContainerSpawnSupport =
  | { supported: true }
  | { supported: false; uvVersion: string; message: string };

export class AppContainerSpawnUnsupportedError extends Error {
  readonly code = "OPENCLAW_APPCONTAINER_SPAWN_UNSUPPORTED";
  constructor(message: string) {
    super(message);
    this.name = "AppContainerSpawnUnsupportedError";
  }
}

/** True when `uvVersion` is at least 1.53.0; an unreadable version is not refused. */
export function libuvNamesAppContainerPipes(uvVersion: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(uvVersion);
  if (!match) {
    return true;
  }
  const parts = [match[1], match[2], match[3]].map(Number);
  for (const [index, minimum] of APPCONTAINER_MIN_LIBUV.entries()) {
    const part = parts[index] ?? 0;
    if (part !== minimum) {
      return part > minimum;
    }
  }
  return true;
}

export function resolveAppContainerSpawnSupport(params: {
  platform: NodeJS.Platform;
  inAppContainer: boolean;
  uvVersion: string | undefined;
}): AppContainerSpawnSupport {
  const uvVersion = params.uvVersion ?? "";
  if (
    params.platform !== "win32" ||
    !params.inAppContainer ||
    libuvNamesAppContainerPipes(uvVersion)
  ) {
    return { supported: true };
  }
  return {
    supported: false,
    uvVersion,
    message:
      `Cannot start child processes: this process runs inside a Windows AppContainer, and its ` +
      `Node.js carries libuv ${uvVersion}, which names child pipes outside \\\\.\\pipe\\LOCAL\\ ` +
      `so the spawn never completes. Use a Node.js build whose libuv is ` +
      `${APPCONTAINER_MIN_LIBUV_VERSION} or later (process.versions.uv).`,
  };
}

/** Reads TokenIsAppContainer from this process's token; any failure reads as "not contained". */
function isWindowsAppContainerProcess(): boolean {
  try {
    const require = createRequire(import.meta.url);
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
    // TOKEN_QUERY
    if (!openToken(getCurrentProcess(), 0x0008, token)) {
      return false;
    }
    try {
      const isAppContainer = Buffer.alloc(4);
      // TokenIsAppContainer (29) is a DWORD.
      return (
        getTokenInformation(token[0], 29, isAppContainer, 4, [0]) !== 0 &&
        isAppContainer.readUInt32LE(0) !== 0
      );
    } finally {
      closeHandle(token[0]);
    }
  } catch {
    return false;
  }
}

let cachedSupport: AppContainerSpawnSupport | undefined;

/** The token and libuv never change within a process, so this is read once. */
export function readAppContainerSpawnSupport(): AppContainerSpawnSupport {
  cachedSupport ??= resolveAppContainerSpawnSupport({
    platform: process.platform,
    inAppContainer: process.platform === "win32" && isWindowsAppContainerProcess(),
    uvVersion: process.versions.uv,
  });
  return cachedSupport;
}

/** Throws before a spawn that could only hang; a no-op everywhere else. */
export function assertAppContainerSpawnSupported(): void {
  const support = readAppContainerSpawnSupport();
  if (!support.supported) {
    throw new AppContainerSpawnUnsupportedError(support.message);
  }
}
