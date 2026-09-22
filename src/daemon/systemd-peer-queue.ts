/** One sd-bus connection; callers may expire while waiting, disposal still joins native work. */
export function createSystemdPeerQueue() {
  let tail: Promise<void> = Promise.resolve();
  return {
    drain: () => tail,
    run<T>(deadline: number, execute: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let expired = false;
        const expire = () => {
          expired = true;
          reject(new Error("Original systemd manager peer query deadline expired."));
        };
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          expire();
          return;
        }
        const timer = setTimeout(expire, remaining);
        const work = tail.then(async () => {
          clearTimeout(timer);
          if (expired || performance.now() >= deadline) {
            expire();
            return;
          }
          // Once started, the native call owns its absolute deadline. We must
          // join its actual completion, even when another queued caller expires.
          try {
            resolve(await execute());
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new Error("Original systemd manager peer query failed.", { cause: error }),
            );
          }
        });
        // An ordinary property error is not an identity change. The next query
        // revalidates the same connection instead of inheriting that rejection.
        tail = work.then(() => {}, reject);
      });
    },
  };
}
