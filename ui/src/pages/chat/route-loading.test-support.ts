import { loadChatRoute } from "./route-loader.ts";

export const routeLocation = (pathname: string, search = "") => ({ pathname, search, hash: "" });

export function loadRoute(
  context: Parameters<typeof loadChatRoute>[0],
  target: string | Parameters<typeof loadChatRoute>[1],
  search = "",
  face: Parameters<typeof loadChatRoute>[2] = "chat",
) {
  return loadChatRoute(
    context,
    typeof target === "string" ? routeLocation(target, search) : target,
    face,
    new AbortController().signal,
  );
}
