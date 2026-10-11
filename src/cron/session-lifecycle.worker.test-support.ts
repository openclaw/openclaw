export function createCronMutationProbe(sessionKey: string) {
  return {
    sessionKey,
    readerReleases: new Set<() => void>(),
    release() {
      for (const release of this.readerReleases) {
        release();
      }
    },
  };
}
export type CronMutationProbe = ReturnType<typeof createCronMutationProbe>;
