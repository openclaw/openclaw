import type { StoredClaw } from "./claw-store.js";

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
     * Records a confirmed publication of `record`'s binding (Discovery had its published binding
     * before) and returns whether this is a re-bind's first one, whose owners get the notice. An
     * owner reset's binding keeps the keys and gets none.
     */
    published(record: StoredClaw): boolean {
      code = undefined;
      const bindingSeq = record.binding?.body.binding_seq ?? 0;
      if (
        bindingSeq <= Math.max(1, record.discovery.published_binding_seq, noticeSeq) ||
        record.reset?.statement.body.binding_seq === bindingSeq
      ) {
        return false;
      }
      noticeSeq = bindingSeq;
      return true;
    },
  };
}
