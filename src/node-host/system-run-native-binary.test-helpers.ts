import fs from "node:fs";
import path from "node:path";

function canWritePathSync(targetPath: string): boolean {
  try {
    fs.accessSync(targetPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function canMutateNativeBinaryFixturePath(binaryPath: string): boolean {
  const realPath = fs.realpathSync(binaryPath);
  return [binaryPath, path.dirname(binaryPath), realPath, path.dirname(realPath)].some((entry) =>
    canWritePathSync(entry),
  );
}

let cachedNativeBinaryFixturePath: string | undefined;

export function resolveNativeBinaryFixturePath(): string {
  if (cachedNativeBinaryFixturePath) {
    return cachedNativeBinaryFixturePath;
  }
  for (const candidate of ["/bin/ls", "/usr/bin/ls", "/bin/echo", "/usr/bin/printf"]) {
    try {
      if (fs.statSync(candidate).isFile()) {
        cachedNativeBinaryFixturePath = candidate;
        return candidate;
      }
    } catch {
      continue;
    }
  }
  throw new Error("expected a native binary fixture path");
}
