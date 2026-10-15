import { solidContent } from "../lit/solid-content.tsx";
import { ConnectingSplash } from "./solid/loading-skeleton.tsx";

export function renderConnectingSplash(status?: string) {
  return solidContent(ConnectingSplash, { status });
}
