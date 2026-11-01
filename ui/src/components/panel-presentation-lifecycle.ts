/** Publishes panel state synchronously and settles each coalesced DOM commit once. */
export function createPanelPresentationLifecycle(
  scheduleAfterRender: (callback: () => void) => void,
  reconcile: () => void,
  initialRender?: () => void,
) {
  let render = initialRender;
  let connected = false;
  let completion: Promise<boolean> = Promise.resolve(true);
  let complete: ((value: boolean) => void) | undefined;

  function publish(): void {
    if (!connected) {
      return;
    }
    const needsCommit = !complete;
    if (needsCommit) {
      completion = new Promise((resolve) => {
        complete = resolve;
      });
    }
    const pending = complete;
    render?.();
    if (needsCommit) {
      scheduleAfterRender(() => {
        // Detach retires this receipt before a retained host starts another render.
        if (complete !== pending) {
          return;
        }
        // Reconciliation can publish the next commit before this one settles.
        complete = undefined;
        reconcile();
        pending?.(true);
      });
    }
  }

  return {
    publish,
    active: () => connected,
    get updateComplete() {
      return completion;
    },
    connect() {
      connected = true;
    },
    dispose(teardown?: () => void) {
      connected = false;
      teardown?.();
      complete?.(false);
      complete = undefined;
    },
    subscribe(this: void, listener: () => void) {
      render = listener;
      return () => {
        render = undefined;
      };
    },
  };
}
