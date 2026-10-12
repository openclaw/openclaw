/** Retain a method before spying while requiring its original receiver at every call. */
export function captureMethodCall<Key extends string>(key: Key) {
  return <Receiver, Args extends unknown[], Result>(
    target: { [Name in Key]: (...args: Args) => Result } & Receiver,
  ): ((receiver: Receiver, ...args: Args) => Result) => {
    const original = target[key];
    return (receiver, ...args) => original.apply(receiver, args);
  };
}
