export type WorkerTriggerLoopResult = {
  ok: true;
  command: "worker trigger loop";
  mode: "local-contract";
  executed: false;
  message: string;
};

export function buildWorkerTriggerLoopResult(): WorkerTriggerLoopResult {
  return {
    ok: true,
    command: "worker trigger loop",
    mode: "local-contract",
    executed: false,
    message: "Worker trigger loop accepted by the local contract; no external dispatch executed.",
  };
}

export async function workerTriggerLoopCommand(): Promise<void> {
  process.stdout.write(`${JSON.stringify(buildWorkerTriggerLoopResult())}\n`);
}
