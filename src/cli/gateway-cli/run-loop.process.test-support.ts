import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";

export function observeChild(child: ChildProcess, signal: AbortSignal) {
  const closed = once(child, "close");
  void closed.catch(() => {});
  let output = "";
  const changes = new EventEmitter();
  const record = (chunk: Buffer) => {
    output += chunk.toString();
    changes.emit("output");
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  return {
    closed,
    get output() {
      return output;
    },
    async waitForOutput(text: string) {
      let inspect = () => {};
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            new Promise<void>((resolve) => {
              inspect = () => {
                if (output.includes(text)) {
                  resolve();
                }
              };
              changes.on("output", inspect);
              inspect();
            }),
            closed,
            `Missing ${text}`,
          ),
          signal,
        );
      } catch (cause) {
        throw new Error(`Missing ${text}: ${output}`, { cause });
      } finally {
        changes.off("output", inspect);
      }
    },
  };
}
