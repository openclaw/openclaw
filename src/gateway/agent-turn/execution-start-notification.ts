import { isPromiseLike } from "@openclaw/normalization-core/promise-like";

/** Required startup writes settle before publication and continuation; sync observers stay sync. */
export function createExecutionStartNotification(params: {
  markStarted: () => boolean;
  notify: (() => void) | (() => Promise<void>);
  assertCurrent: () => void;
  publish: () => void;
}): () => void | Promise<void> {
  return () => {
    if (!params.markStarted()) {
      return undefined;
    }
    const publish = () => {
      params.assertCurrent();
      params.publish();
    };
    const started = params.notify();
    if (isPromiseLike(started)) {
      return Promise.resolve(started).then(publish);
    }
    return publish();
  };
}
