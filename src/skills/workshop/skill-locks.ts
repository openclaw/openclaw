const skillLocks = new Map<string, Promise<void>>();

async function withSkillLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = skillLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  skillLocks.set(key, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (skillLocks.get(key) === tail) {
      skillLocks.delete(key);
    }
  }
}

/** Takes every key's lock in sorted order, so overlapping multi-skill mutations cannot deadlock. */
export async function withSkillLocks<T>(
  keys: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  const [first, ...rest] = [...new Set(keys)].toSorted((a, b) => a.localeCompare(b));
  return first === undefined
    ? await run()
    : await withSkillLock(first, () => withSkillLocks(rest, run));
}
