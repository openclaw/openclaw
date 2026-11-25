import path from "node:path";
import { finallyRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { resolveStateDir } from "../config/paths.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import {
  captureRetainedNativeWorkerSource,
  type RetainedNativeWorkerSource,
} from "../infra/worker-native-lifecycle.js";
import { createOwnedWorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { TtsUserPrefs } from "./tts-settings.js";

export type TtsPreferenceWrite = {
  prefsPath: string;
  stateDir: string;
  patch: NonNullable<TtsUserPrefs["tts"]>;
};

type TtsPreferenceWriter = {
  pool: ReturnType<typeof createOwnedWorkerTaskPool<TtsPreferenceWrite, void>>;
  pending: Set<Promise<void>>;
  waitSignal: Int32Array<SharedArrayBuffer>;
  closing: boolean;
};

const owners = resolveGlobalSingleton(
  Symbol.for("openclaw.ttsPreferenceWriters"),
  () => new WeakMap<RetainedNativeWorkerSource, TtsPreferenceWriter>(),
);

function prepareWrite(
  prefsPath: string,
  patch: TtsPreferenceWrite["patch"],
): { owner: TtsPreferenceWriter; input: TtsPreferenceWrite } {
  const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  let owner = owners.get(source);
  if (!owner) {
    owner = {
      pool: createOwnedWorkerTaskPool<TtsPreferenceWrite, void>(
        {
          workerUrl: resolveRuntimeProcessEntrypointUrl("ttsPreferences"),
          maxWorkers: 1,
          maxPendingTasks: 256,
          idleTimeoutMs: 60_000,
        },
        { retainedTransport: true, nativeSource: source },
      ),
      pending: new Set(),
      waitSignal: new Int32Array(new SharedArrayBuffer(4)),
      closing: false,
    };
    owners.set(source, owner);
    const retained = owner;
    source.retain(owner, async () => {
      retained.closing = true;
      await Promise.allSettled(retained.pending);
      await retained.pool.close();
    });
  }
  if (owner.closing) {
    throw new Error("TTS preference writer is closing");
  }
  return {
    owner,
    input: { prefsPath: path.resolve(prefsPath), stateDir: resolveStateDir(), patch },
  };
}

/** Retain the private-store boundary until fs-safe's durable async writer is nonblocking. */
export async function updateTtsPrefsAsync(
  prefsPath: string,
  patch: TtsPreferenceWrite["patch"],
): Promise<void> {
  const { owner, input } = prepareWrite(prefsPath, patch);
  const write = owner.pool.run(input, {});
  owner.pending.add(write);
  try {
    await write;
  } finally {
    owner.pending.delete(write);
  }
}

/** Legacy SDK calls join the same FIFO owner without depending on host Promise reactions. */
export function updateTtsPrefsSync(prefsPath: string, patch: TtsPreferenceWrite["patch"]): void {
  const { owner, input } = prepareWrite(prefsPath, patch);
  const task = owner.pool.startTask(input, { progressSignal: owner.waitSignal });
  const write = finallyRetainedOperation(task, () => task.release());
  for (;;) {
    const observed = Atomics.load(owner.waitSignal, 0);
    // Ordinary async tasks release their slots during service, without Promise reactions.
    write.service();
    const outcome = write.read();
    if (outcome.status === "fulfilled") {
      return;
    }
    if (outcome.status === "rejected") {
      throw outcome.error;
    }
    Atomics.wait(owner.waitSignal, 0, observed, 2);
  }
}
