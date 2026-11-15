export function mapChatDisplayMessages<T>(messages: T[], project: (message: T) => T): T[] {
  let projected: T[] | undefined;
  messages.forEach((message, index) => {
    const next = project(message);
    if (next !== message) {
      projected ??= messages.slice();
      projected[index] = next;
    }
  });
  return projected ?? messages;
}
