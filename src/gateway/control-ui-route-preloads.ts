export const CONTROL_UI_ROUTE_PRELOAD_ATTRIBUTE = "data-openclaw-route-preloads";

const routePreloadTemplate = new RegExp(
  `<template ${CONTROL_UI_ROUTE_PRELOAD_ATTRIBUTE}="([^"]+)">([\\s\\S]*?)</template>`,
  "g",
);

/** Activate only the requested route's build-emitted preload hints. */
export function selectControlUiRoutePreloads(html: string, route: "chat" | "new" | null): string {
  return html.replace(routePreloadTemplate, (_template, templateRoute: string, preloads: string) =>
    templateRoute === route ? preloads : "",
  );
}
