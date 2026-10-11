import { getLobsterdexEntries, subscribeLobsterdex } from "../../components/lobster-dex.ts";
import { projectSource } from "./projection.ts";

export function projectLobsterdex() {
  return projectSource(
    { read: getLobsterdexEntries, subscribe: subscribeLobsterdex },
    {
      read: (source) => source.read(),
      subscribe: (source, notify) => source.subscribe(notify),
      equality: "revision",
    },
  );
}
