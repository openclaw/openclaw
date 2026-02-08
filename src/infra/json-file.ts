import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function loadJsonFile(pathname: string): unknown {
  try {
    if (!fs.existsSync(pathname)) {
      return undefined;
    }
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const payload = `${JSON.stringify(data, null, 2)}\n`;

  // Windows: avoid rename-swap edge cases under concurrent access.
  // Callers that need stronger guarantees should serialize writes with a lock.
  if (process.platform === "win32") {
    fs.writeFileSync(pathname, payload, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(pathname, 0o600);
    return;
  }

  const tmp = `${pathname}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, payload, { encoding: "utf8" });
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmp, pathname);
    fs.chmodSync(pathname, 0o600);

    // Persist directory entry update on POSIX filesystems.
    // Some filesystems may not support directory fsync; treat as best-effort.
    try {
      const dirFd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // best-effort
    }
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
