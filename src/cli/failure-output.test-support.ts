import { onTestFinished } from "vitest";
import { readGlobalSingleton } from "../shared/global-singleton.js";

export async function captureCliUncaughtExceptionListener(start: () => Promise<unknown>) {
  const before = process.listeners("uncaughtException");
  await start();
  const owner = readGlobalSingleton(
    Symbol.for("openclaw.processFailureListener.uncaughtException"),
  ) as { listener: unknown } | undefined;
  const listener = process
    .listeners("uncaughtException")
    .find((entry) => entry === owner?.listener);
  if (!listener) {
    throw new Error("OpenClaw uncaughtException handler was not registered");
  }
  if (!before.includes(listener)) {
    onTestFinished(() => {
      process.off("uncaughtException", listener);
    });
  }
  return listener;
}
