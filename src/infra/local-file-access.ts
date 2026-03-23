import { fileURLToPath, URL } from "node:url";

function isLocalFileUrlHost(hostname: string): boolean {
  return hostname === "" || hostname.toLowerCase() === "localhost";
}

export function isWindowsNetworkPath(filePath: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const normalized = filePath.replace(/\//g, "\\");
  return normalized.startsWith("\\\\?\\UNC\\") || normalized.startsWith("\\\\");
}

export function assertNoWindowsNetworkPath(filePath: string, label = "Path"): void {
  if (isWindowsNetworkPath(filePath)) {
    throw new Error(`${label} cannot use Windows network paths: ${filePath}`);
  }
}

export function safeFileURLToPath(fileUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(fileUrl);
  } catch {
    throw new Error(`Invalid file:// URL: ${fileUrl}`);
  }
  if (parsed.protocol !== "file:") {
    throw new Error(`Invalid file:// URL: ${fileUrl}`);
  }
  if (!isLocalFileUrlHost(parsed.hostname)) {
    throw new Error(`file:// URLs with remote hosts are not allowed: ${fileUrl}`);
  }
  const filePath = fileURLToPath(parsed);
  assertNoWindowsNetworkPath(filePath, "Local file URL");
  return filePath;
}
