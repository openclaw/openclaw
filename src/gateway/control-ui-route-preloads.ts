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

/** Reuse build-emitted hints; optional interactions must not compete with first paint. */
export function controlUiPreloadLinks(html: string): string[] {
  const links: string[] = [];
  for (const match of html.matchAll(/<(?:link|script)\b[^>]*>/g)) {
    const tag = match[0];
    if (/\bfetchpriority="low"/.test(tag)) {
      continue;
    }
    const href = /\b(?:href|src)="(\/[^"<>?#]*\/assets\/[\w.-]+|\/assets\/[\w.-]+)"/.exec(tag)?.[1];
    if (!href) {
      continue;
    }
    if (/\brel="modulepreload"|\btype="module"/.test(tag)) {
      links.push(`<${href}>; rel=modulepreload; crossorigin`);
    } else if (/\brel="stylesheet"|\bas="style"/.test(tag)) {
      links.push(`<${href}>; rel=preload; as=style; crossorigin`);
    }
  }
  return [...new Set(links)];
}
