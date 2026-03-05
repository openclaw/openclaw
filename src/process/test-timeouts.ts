export const PROCESS_TEST_TIMEOUT_MS = {
  tiny: 25,
  short: 100,
  standard: 3_000,
  medium: 5_000,
  long: 10_000,
  extraLong: 15_000,
} as const;

export const PROCESS_TEST_SCRIPT_DELAY_MS = {
  silentProcess: 120,
  streamingInterval: 1_800,
  streamingDuration: 9_000,
} as const;

export const PROCESS_TEST_NO_OUTPUT_TIMEOUT_MS = {
  exec: 120,
  supervisor: 100,
  streamingAllowance: 6_000,
} as const;
