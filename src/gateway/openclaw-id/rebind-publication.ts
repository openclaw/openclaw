// What the Gateway keeps in memory about publishing a re-bind: the owner account's one-time
// code (for this process's retries only; a restart asks for `openclaw id publish --code`) and
// which binding's `rebind` notice it already mailed, so overlapping publications send one.
export function createRebindPublication() {
  let code: string | undefined;
  let noticeSeq = 0;
  return {
    hold(next: string | undefined): void {
      code = next;
    },
    /** The code to publish with: the caller's, else the one held for the re-bind. */
    code(given?: string): string | undefined {
      return given ?? code;
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
