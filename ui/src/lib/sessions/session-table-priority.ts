import { initialSessionsTables, requestSessionListWindow } from "./session-requests.ts";

export function prioritizeInitialSessionsTable(initialClient: object) {
  const ready = Promise.withResolvers<void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    clearTimeout(timer);
    initialSessionsTables.delete(initialClient);
    ready.resolve();
  };
  initialSessionsTables.set(initialClient, {
    async requestWindow(client, query, isCurrent, options) {
      const { source } = query;
      if (source === "sidebar" || source === "agent-roster") {
        timer ??= setTimeout(release, 350);
        await ready.promise;
        if (!isCurrent()) {
          return null;
        }
      }
      return requestSessionListWindow(client, query, isCurrent, options);
    },
    tablePresented() {
      requestAnimationFrame(() => requestAnimationFrame(release));
    },
  });
}
