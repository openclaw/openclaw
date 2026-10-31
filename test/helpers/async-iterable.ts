export async function collect<T>(stream: AsyncIterable<T>) {
  const events: T[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
