/** Transport callers retain the public handoff shape without cron receipt custody. */
export function captureEffectAuthority() {
  return {
    active: false,
    run<T>(run: () => T): T {
      return run();
    },
    async initiate<T>(effect: () => T | Promise<T>): Promise<T> {
      return effect();
    },
  };
}

/** Independent owners, such as transport crypto maintenance, restore their own scope explicitly. */
export function withEffectAuthority<T>(
  authority: ReturnType<typeof captureEffectAuthority> | undefined,
  run: () => T,
): T {
  return authority ? authority.run(run) : run();
}
