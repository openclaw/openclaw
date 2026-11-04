import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { waitForBrokerChildCompletion } from "./child-completion.js";
import { terminateLostBrokerChild } from "./cleanup.js";
import type { ProcessOutputFile } from "./protocol.js";

/** The spawning process owns the destination and joins every write before releasing it. */
export async function prepareProcessOutputFile(target: ProcessOutputFile) {
  const file = await fs.open(target.path, "wx", 0o600);
  let writing: Promise<number> | undefined;
  return {
    stdio: target.maxBytes === undefined ? file.fd : ("pipe" as const),
    start(
      child: ChildProcess,
      detached = false,
      completed = waitForBrokerChildCompletion(child),
    ): Promise<number> {
      let bytes = 0;
      const maxBytes = target.maxBytes;
      writing = (async () => {
        try {
          await once(child, "spawn");
          if (maxBytes === undefined) {
            await completed;
            return (await file.stat()).size;
          }
          if (!child.stdout) {
            throw new Error("Process output pipe is unavailable");
          }
          await pipeline(
            child.stdout,
            new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                bytes += chunk.byteLength;
                callback(
                  bytes > maxBytes
                    ? Object.assign(new Error(`Process output exceeds ${maxBytes} bytes`), {
                        code: "ERR_PROCESS_OUTPUT_LIMIT",
                      })
                    : null,
                  chunk,
                );
              },
            }),
            file.createWriteStream(),
          );
          await completed;
          return bytes;
        } catch (error: unknown) {
          const termination = child.pid ? terminateLostBrokerChild(child.pid, detached) : undefined;
          termination?.force();
          await Promise.all([completed, termination?.settled]);
          throw error;
        } finally {
          await file.close();
        }
      })();
      void writing.catch(() => {});
      return writing;
    },
    async close(): Promise<void> {
      if (writing) {
        await writing.catch(() => {});
      } else {
        await file.close();
      }
    },
  };
}
