import { projectSource, type SourceProjection } from "./projection.ts";

/** Private leaf owners have one callback; the projection owns observation and fan-out. */
export function projectCallbackOwner<S, T>(
  create: (notify: () => void) => S,
  read: (owner: S) => T,
): { owner: S; view: Omit<SourceProjection<S, T>, "replaceSource"> } {
  let publish: (() => void) | undefined;
  const owner = create(() => publish?.());
  const view = projectSource(owner, {
    read,
    subscribe: (_, notify) => {
      publish = notify;
      return () => {
        publish = undefined;
      };
    },
    equality: "revision",
  });
  return { owner, view };
}
