import { createTempHomeEnv } from "../test-utils/temp-home.js";

export async function withTempHome<T>(
  prefix: string,
  fn: (home: string) => Promise<T>,
): Promise<T> {
  const tempHome = await createTempHomeEnv(prefix);

  try {
    return await fn(tempHome.home);
  } finally {
    await tempHome.restore();
  }
}
