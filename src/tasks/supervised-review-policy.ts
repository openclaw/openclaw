// Host policy, not model input or a fabricated command/attempt profile.
export const SUPERVISED_REVIEW_LIMITS = Object.freeze({ memoryBytes: 2 * 1024 ** 3, tasks: 256 });
export const SUPERVISED_REVIEW_STORAGE = Object.freeze({
  workingBytes: 128 * 1024 ** 2,
  workingInodes: 32768,
});
