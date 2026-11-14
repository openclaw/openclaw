// What the Gateway keeps in memory about publishing a re-bind: the owner account's one-time
// code (held for this process's retries until a publication succeeds; a restart asks for
// `openclaw id publish --code`, whose code is then held the same way) and
// which binding's `rebind` notice it already mailed, so overlapping publications send one.
export function createRebindPublication() {
  let code: string | undefined;
  let noticeSeq = 0;
  return {
    hold: (next: string | undefined): void => {
      code = next;
    },
    /**
     * The code to publish with: the caller's (held from now on for retries), else the held one.
     * Taken before registration recovery, which can fail transiently and leave it to a retry.
     */
    code(given?: string): string | undefined {
      code = given ?? code;
      return code;
    },
    /**
     * Records a confirmed publication of `bindingSeq` (Discovery had `publishedSeq` before) and
     * returns whether this is a re-bind's first one, whose owners get the notice.
     */
    published(bindingSeq: number, publishedSeq: number): boolean {
      code = undefined;
      if (bindingSeq <= Math.max(1, publishedSeq, noticeSeq)) {
        return false;
      }
      noticeSeq = bindingSeq;
      return true;
    },
  };
}
