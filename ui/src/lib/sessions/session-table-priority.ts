import { initialSessionsTables } from "./session-requests.ts";

export function prioritizeInitialSessionsTable(client: object) {
  const ready = Promise.withResolvers<void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    clearTimeout(timer);
    initialSessionsTables.delete(client);
    ready.resolve();
  };
  initialSessionsTables.set(client, {
    waitForTable(source) {
      if (source === "sidebar" || source === "agent-roster") {
        timer ??= setTimeout(release, 350);
        return ready.promise;
      }
      return undefined;
    },
    tablePresented() {
      requestAnimationFrame(() => requestAnimationFrame(release));
    },
  });
}
