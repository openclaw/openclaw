import { action, createOptimistic, createSignal, onSettled } from "solid-js";
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
  const [failedUrl, setFailedUrl] = createSignal<string>();
  let mounted = false;
  let active: CopyAttempt | undefined;
  const current = (attempt: CopyAttempt) =>
    mounted && active === attempt && options.presented() && options.url() === attempt.url;
  const retire = () => {
    active?.retired.resolve();
    active = undefined;
    setFailedUrl(undefined);
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
    failed: () => failedUrl() !== undefined && failedUrl() === options.url(),
    retire,
    async copy() {
      const url = options.url();
      if (!url || !mounted || !options.presented() || (active && current(active))) {
        return;
      }
      retire();
      const attempt = { url, retired: Promise.withResolvers<void>() };
      active = attempt;
      setFailedUrl(undefined);
      // Start before the action and its microtask so browser activation remains intact.
      const completion = copyToClipboard(url, () => current(attempt))
        .then((copied) => {
          if (!current(attempt)) {
            return;
          }
          if (copied) {
            options.onCopied();
          } else {
            setFailedUrl(url);
          }
        })
        .catch(() => {
          if (current(attempt)) {
            setFailedUrl(url);
          }
        })
        .finally(() => {
          if (active === attempt) {
            active = undefined;
          }
        });
      await Promise.resolve();
      await present(completion, attempt);
    },
  };
}
