export function createPendingPromiseTracker<Value>(pending: Set<Promise<Value>>) {
  return <T extends Value>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    const settled = () => pending.delete(work);
    void work.then(settled, settled);
    return work;
  };
}
