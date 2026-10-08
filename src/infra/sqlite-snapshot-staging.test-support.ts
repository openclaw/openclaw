import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { RetainedNativeWorker } from "./worker-native-lifecycle.types.js";

type NativeSubscription =
  | [event: "message", listener: (message: unknown) => void]
  | [event: "error" | "messageerror", listener: (error: Error) => void]
  | [event: "started", listener: () => void]
  | [event: "execution-exit" | "exit", listener: (code: number | undefined) => void];

export function holdAllocatedReply(
  native: RetainedNativeWorker,
  receive: (directory: string) => boolean,
): void {
  const on = native.on.bind(native);
  function listen(event: "message", listener: (message: unknown) => void): unknown;
  function listen(event: "error" | "messageerror", listener: (error: Error) => void): unknown;
  function listen(event: "started", listener: () => void): unknown;
  function listen(event: "execution-exit", listener: (code: number | undefined) => void): unknown;
  function listen(event: "exit", listener: (code: number | undefined) => void): unknown;
  function listen(...[event, listener]: NativeSubscription): unknown {
    if (event !== "message") {
      return Reflect.apply(on, native, [event, listener]);
    }
    return on("message", (message) => {
      if (
        isRecord(message) &&
        message.status === "ok" &&
        typeof message.taskId === "number" &&
        isRecord(message.value) &&
        message.value.type === "allocated" &&
        typeof message.value.directory === "string" &&
        receive(message.value.directory)
      ) {
        return;
      }
      listener(message);
    });
  }
  native.on = listen;
}
