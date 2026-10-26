export type CurrentReadAuthority = {
  assertCurrent?: () => void;
  withCurrent?: <T>(consume: () => T) => Promise<Awaited<T>>;
};

/** Begin private preparation in the same synchronous frame as the refreshed authority. */
export async function withCurrentReadAuthority<T>(
  authority: CurrentReadAuthority | undefined,
  consume: () => T,
): Promise<Awaited<T>> {
  const read = () => {
    authority?.assertCurrent?.();
    return consume();
  };
  return await (authority?.withCurrent ? authority.withCurrent(read) : read());
}

/** Keep the first failure while joining every preparation already started by the caller. */
export async function settleCurrentReadPreparations<T extends readonly unknown[]>(
  preparations: T,
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  try {
    return await Promise.all(preparations);
  } catch (error) {
    await Promise.allSettled(preparations);
    throw error;
  }
}
