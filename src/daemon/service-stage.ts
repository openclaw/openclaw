/** Native writer facts are evidence, never serialized lifecycle authority. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readRegularFile } from "@openclaw/fs-safe/advanced";
import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";
import { z } from "zod";
import { hasErrnoCode } from "../infra/errno.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";

const fileState = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.number().int().nonnegative(),
  dev: z.number().nonnegative(),
  ino: z.number().nonnegative(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().finite(),
  ctimeMs: z.number().finite(),
});
const definitionFile = z.strictObject({
  sourcePath: z.string().max(4096).refine(path.isAbsolute),
  before: fileState.nullable(),
  after: fileState.nullable(),
  prepared: fileState.nullable().optional(),
});
export const GatewayServiceDefinitionBackupReceiptSchema = z.strictObject({
  id: z.uuid(),
  files: z.array(definitionFile).min(1).max(4),
  guards: z.array(definitionFile.pick({ sourcePath: true, after: true })),
  task: z
    .strictObject({
      beforeSha256: fileState.shape.sha256,
      afterPolicySha256: fileState.shape.sha256,
      preparedXml: z.string().min(1).optional(),
      recoveredPolicy: z.enum(["previous", "prepared"]).optional(),
    })
    .optional(),
});
export type GatewayServiceDefinitionBackupReceipt = z.infer<
  typeof GatewayServiceDefinitionBackupReceiptSchema
>;
export type GatewayServiceDefinitionTransactionHooks = {
  preservePolicy?: readonly string[];
  assertCurrent: () => void;
  beforeWrite: () => Promise<void>;
  filePrepared: (sourcePath: string, temporaryPath: string | null) => Promise<void>;
  fileWritten: (sourcePath: string, contents: string | Uint8Array | null) => Promise<void>;
  taskWritten: (expectedXml: string) => Promise<void>;
  taskPrepared: (expectedXml: string) => Promise<void>;
};
type GatewayServiceFileState = z.infer<typeof fileState>;

/** Keep the live file runnable until a complete replacement is ready. */
export async function publishServiceFile(params: {
  filePath: string;
  contents: string | Uint8Array;
  mode: number;
  definitionTransaction?: GatewayServiceDefinitionTransactionHooks;
  beforeRename?: () => Promise<void>;
  assertCurrent?: () => void;
}): Promise<void> {
  const hooks = params.definitionTransaction;
  const dirMode = (await fs.stat(path.dirname(params.filePath))).mode & 0o7777;
  assertGatewayServiceUpdateCurrent();
  await replaceFileAtomic({
    filePath: params.filePath,
    content: params.contents,
    mode: params.mode,
    dirMode,
    tempPrefix: `.${path.basename(params.filePath)}.openclaw`,
    syncTempFile: true,
    syncParentDir: true,
    // Windows sharing violations must preserve the old launcher, never copy over it.
    copyFallbackOnPermissionError: false,
    fileSystem: {
      promises: {
        ...fs,
        rename: async (temporary, target) => {
          await params.beforeRename?.();
          await hooks?.beforeWrite();
          await hooks?.filePrepared(params.filePath, String(temporary));
          assertGatewayServiceUpdateCurrent();
          hooks?.assertCurrent();
          params.assertCurrent?.();
          await fs.rename(temporary, target);
        },
      },
    },
  });
  await hooks?.fileWritten(params.filePath, params.contents);
}

/** Read one regular file; publication owners compare it to retained write facts. */
export async function readServiceFileState(file: string): Promise<GatewayServiceFileState | null> {
  const before = await fs.lstat(file).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (!before) {
    return null;
  }
  if (!before.isFile()) {
    throw new Error("Managed service artifact is not a regular file.");
  }
  const { buffer: contents, stat: opened } = await readRegularFile({ filePath: file });
  const keys = ["dev", "ino", "mode"] as const;
  if (keys.some((key) => before[key] !== opened[key])) {
    throw new Error("Managed service artifact changed before inspection.");
  }
  const current = await fs.lstat(file);
  if (keys.some((key) => opened[key] !== current[key])) {
    throw new Error("Managed service artifact changed during inspection.");
  }
  return {
    sha256: createHash("sha256").update(contents).digest("hex"),
    mode: opened.mode & 0o7777,
    dev: opened.dev,
    ino: opened.ino,
    size: contents.byteLength,
    mtimeMs: opened.mtimeMs,
    ctimeMs: opened.ctimeMs,
  };
}
