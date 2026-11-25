type ConfigIoEffect = {
  sync: () => void;
  async: () => Promise<void>;
};

export type ConfigIoOperation<T> = Generator<ConfigIoEffect, T, void>;

export function* resolveConfigIoEffect<T>(effect: {
  sync: () => T;
  async: () => Promise<T>;
}): ConfigIoOperation<T> {
  // Keep yielded results typed without asserting a heterogeneous generator's return values.
  let result!: T;
  yield {
    sync: () => {
      result = effect.sync();
    },
    async: async () => {
      result = await effect.async();
    },
  };
  return result;
}

export function runConfigIoSync<T>(operation: ConfigIoOperation<T>, assertCurrent?: () => void): T {
  let step = operation.next();
  while (!step.done) {
    try {
      assertCurrent?.();
      step.value.sync();
      assertCurrent?.();
      step = operation.next();
    } catch (error) {
      step = operation.throw(error);
    }
  }
  return step.value;
}

export async function runConfigIoAsync<T>(
  operation: ConfigIoOperation<T>,
  assertCurrent?: () => void,
): Promise<T> {
  let step = operation.next();
  while (!step.done) {
    try {
      assertCurrent?.();
      await step.value.async();
      assertCurrent?.();
      step = operation.next();
    } catch (error) {
      step = operation.throw(error);
    }
  }
  return step.value;
}
