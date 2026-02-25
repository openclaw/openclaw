import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runExec } from "../process/exec.js";
import { ensureDirForFile, normalizePositiveInt } from "./shared.js";

export const DEFAULT_SOPS_TIMEOUT_MS = 5_000;
const MAX_SOPS_OUTPUT_BYTES = 10 * 1024 * 1024;

function toSopsPath(value: string): string {
  return value.replaceAll(path.sep, "/");
}

function resolveFilenameOverride(params: { targetPath: string }): string {
  return toSopsPath(path.resolve(params.targetPath));
}

function resolveSopsCwd(params: { targetPath: string; configPath?: string }): string {
  if (typeof params.configPath === "string" && params.configPath.trim().length > 0) {
    return path.dirname(params.configPath);
  }
  return path.dirname(params.targetPath);
}

function normalizeTimeoutMs(value: number | undefined): number {
  return normalizePositiveInt(value, DEFAULT_SOPS_TIMEOUT_MS);
}

function isTimeoutError(message: string | undefined): boolean {
  return typeof message === "string" && message.toLowerCase().includes("timed out");
}

type SopsErrorContext = {
  missingBinaryMessage: string;
  operationLabel: string;
};

function toSopsError(err: unknown, params: SopsErrorContext): Error {
  const error = err as NodeJS.ErrnoException & { message?: string };
  if (error.code === "ENOENT") {
    return new Error(params.missingBinaryMessage, { cause: err });
  }
  return new Error(`${params.operationLabel}: ${String(error.message ?? err)}`, {
    cause: err,
  });
}

export async function decryptSopsJsonFile(params: {
  path: string;
  timeoutMs?: number;
  missingBinaryMessage: string;
  configPath?: string;
}): Promise<unknown> {
  const timeoutMs = normalizeTimeoutMs(params.timeoutMs);
  const cwd = resolveSopsCwd({
    targetPath: params.path,
    configPath: params.configPath,
  });
  try {
    const args: string[] = [];
    if (typeof params.configPath === "string" && params.configPath.trim().length > 0) {
      args.push("--config", params.configPath);
    }
    args.push("--decrypt", "--output-type", "json", params.path);
    const { stdout } = await runExec("sops", args, {
      timeoutMs,
      maxBuffer: MAX_SOPS_OUTPUT_BYTES,
      cwd,
    });
    return JSON.parse(stdout) as unknown;
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { message?: string };
    if (isTimeoutError(error.message)) {
      throw new Error(`sops decrypt timed out after ${timeoutMs}ms for ${params.path}.`, {
        cause: err,
      });
    }
    throw toSopsError(err, {
      missingBinaryMessage: params.missingBinaryMessage,
      operationLabel: `sops decrypt failed for ${params.path}`,
    });
  }
}

export async function encryptSopsJsonFile(params: {
  path: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
  missingBinaryMessage: string;
  configPath?: string;
}): Promise<void> {
  ensureDirForFile(params.path);
  const timeoutMs = normalizeTimeoutMs(params.timeoutMs);
  const tmpPlain = path.join(
    path.dirname(params.path),
    `${path.basename(params.path)}.${process.pid}.${crypto.randomUUID()}.plain.tmp`,
  );
  const tmpEncrypted = path.join(
    path.dirname(params.path),
    `${path.basename(params.path)}.${process.pid}.${crypto.randomUUID()}.enc.tmp`,
  );

  fs.writeFileSync(tmpPlain, `${JSON.stringify(params.payload, null, 2)}\n`, "utf8");
  fs.chmodSync(tmpPlain, 0o600);

  try {
    const filenameOverride = resolveFilenameOverride({
      targetPath: params.path,
    });
    const cwd = resolveSopsCwd({
      targetPath: params.path,
      configPath: params.configPath,
    });
    const args: string[] = [];
    if (typeof params.configPath === "string" && params.configPath.trim().length > 0) {
      args.push("--config", params.configPath);
    }
    args.push(
      "--encrypt",
      "--filename-override",
      filenameOverride,
      "--input-type",
      "json",
      "--output-type",
      "json",
      "--output",
      tmpEncrypted,
      tmpPlain,
    );
    await runExec("sops", args, {
      timeoutMs,
      maxBuffer: MAX_SOPS_OUTPUT_BYTES,
      cwd,
    });
    fs.renameSync(tmpEncrypted, params.path);
    fs.chmodSync(params.path, 0o600);
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { message?: string };
    if (isTimeoutError(error.message)) {
      throw new Error(`sops encrypt timed out after ${timeoutMs}ms for ${params.path}.`, {
        cause: err,
      });
    }
    throw toSopsError(err, {
      missingBinaryMessage: params.missingBinaryMessage,
      operationLabel: `sops encrypt failed for ${params.path}`,
    });
  } finally {
    fs.rmSync(tmpPlain, { force: true });
    fs.rmSync(tmpEncrypted, { force: true });
  }
}
