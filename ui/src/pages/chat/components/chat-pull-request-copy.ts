import { action, createMemo, createOptimistic, createSignal, onSettled } from "solid-js";
import { copyToClipboard } from "../../../lib/clipboard.ts";

type CopyAttempt = {
  url: string;
  retired: ReturnType<typeof Promise.withResolvers<void>>;
};

/** Clipboard admission stays in the native gesture; Solid only presents its outcome. */
export function createPullRequestCopy(options: {
  url: () => string | undefined;
  presented: () => boolean;
  onCopied: () => void;
}) {
  const [copying, setCopying] = createOptimistic<CopyAttempt | false>(false);
  const [receipt, setReceipt] = createSignal<{ url: string; result: Promise<void> }>();
  const outcome = createMemo(
    () => {
      const admitted = receipt();
      return admitted && options.presented() && admitted.url === options.url()
        ? admitted.result.then(() => null)
        : null;
    },
    { loadingValue: null },
  );
  let mounted = false;
  let active: CopyAttempt | undefined;
  const current = (attempt: CopyAttempt) =>
    mounted && active === attempt && options.presented() && options.url() === attempt.url;
  const retire = () => {
    active?.retired.resolve();
    active = undefined;
    setReceipt(undefined);
  };
  onSettled(() => {
    mounted = true;
    return () => {
      mounted = false;
      retire();
    };
  });
  const present = action(function* (completion: Promise<void>, attempt: CopyAttempt) {
    if (current(attempt)) {
      setCopying(attempt);
    }
    yield Promise.race([completion, attempt.retired.promise]);
  });
  return {
    copying: () => {
      const attempt = copying();
      return attempt && current(attempt);
    },
    outcome,
    retire,
    async copy() {
      const url = options.url();
      if (!url || !mounted || !options.presented() || (active && current(active))) {
        return;
      }
      retire();
      const attempt = { url, retired: Promise.withResolvers<void>() };
      active = attempt;
      // Start before the action and its microtask so browser activation remains intact.
      const completion = copyToClipboard(url, () => current(attempt))
        .then((copied) => {
          if (!current(attempt)) {
            return;
          }
          if (copied) {
            options.onCopied();
          } else {
            throw new Error("Clipboard copy failed");
          }
        })
        .catch((cause: unknown) => {
          if (current(attempt)) {
            throw cause;
          }
        })
        .finally(() => {
          if (active === attempt) {
            active = undefined;
          }
        });
      setReceipt({ url, result: completion });
      // The alert slot may retire before it observes the admitted outcome.
      void completion.catch(() => {});
      await Promise.resolve();
      await present(completion, attempt).catch(() => {});
    },
  };
}
