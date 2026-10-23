/** A cached runtime retires immediately but releases its workspace after its last evaluation. */
export function createCronTriggerRuntimeLifetime() {
  let runtime: { [Symbol.dispose]?: () => void } | undefined;
  let users = 0;
  let retired = false;
  const dispose = () => {
    if (!retired || users > 0) {
      return;
    }
    const owned = runtime;
    runtime = undefined;
    owned?.[Symbol.dispose]?.();
  };
  return {
    publish(prepared: { [Symbol.dispose]?: () => void }) {
      runtime = prepared;
      dispose();
    },
    retain() {
      users += 1;
      let active = true;
      return () => {
        if (active) {
          active = false;
          users -= 1;
          dispose();
        }
      };
    },
    retire() {
      retired = true;
      dispose();
    },
  };
}
