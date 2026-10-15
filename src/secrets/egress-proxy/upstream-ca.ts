import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_CA_FILE_BYTES = 1024 * 1024;
const CERTIFICATE_PEM = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

export class SecretEgressUpstreamCaError extends Error {
  readonly fileIndex: number;

  constructor(fileIndex: number) {
    super(
      `Invalid secrets.egressProxy.upstreamCaFiles[${fileIndex}]. Use a readable absolute PEM file containing only CA certificates (maximum 1 MiB), then restart the Gateway.`,
    );
    this.fileIndex = fileIndex;
  }
}

function readCaFile(file: string): string {
  // NONBLOCK allows rejecting FIFOs before a blocking read. The descriptor owns
  // admission and bounded reading even if the pathname changes or the file grows.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error("Expected a regular file");
    }
    const buffer = Buffer.alloc(MAX_CA_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) {
        break;
      }
      size += count;
    }
    if (size > MAX_CA_FILE_BYTES) {
      throw new Error("CA file exceeds size limit");
    }
    return buffer.subarray(0, size).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Admit operator-owned CA files once, before the proxy can accept any requests. */
export function loadUpstreamCaFiles(files: readonly string[] = []): string[] {
  return files.flatMap((file, index) => {
    try {
      if (!path.isAbsolute(file)) {
        throw new Error("relative path");
      }
      const pem = readCaFile(file);
      const certificates = pem.match(CERTIFICATE_PEM) ?? [];
      if (
        certificates.length === 0 ||
        pem.replace(CERTIFICATE_PEM, "").trim() !== "" ||
        certificates.some((certificate) => !new X509Certificate(certificate).ca)
      ) {
        throw new Error("invalid CA bundle");
      }
      return certificates;
    } catch {
      // Never echo file contents or OpenSSL diagnostics; a misplaced file may contain a key.
      throw new SecretEgressUpstreamCaError(index);
    }
  });
}
