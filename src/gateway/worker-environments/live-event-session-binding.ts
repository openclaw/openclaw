export type WorkerLiveSessionBinding = Readonly<{
  environmentId: string;
  runEpoch: number;
  sessionId: string;
}>;

export function isValidLiveSessionBinding(binding: WorkerLiveSessionBinding): boolean {
  return (
    binding.environmentId.length > 0 &&
    binding.sessionId.length > 0 &&
    Number.isSafeInteger(binding.runEpoch) &&
    binding.runEpoch >= 0
  );
}
