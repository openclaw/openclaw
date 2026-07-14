import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

type PluginTabRef = {
  pluginId: string;
  id: string;
};
type PluginEntryPointRef = PluginTabRef & {
  entryPoint: true;
  path: string;
  label: string;
};
type PluginPageRef = PluginTabRef | PluginEntryPointRef;

export function isPluginEntryPointRef(ref: PluginPageRef): ref is PluginEntryPointRef {
  return (ref as { entryPoint?: unknown }).entryPoint === true;
}

/** Reads the plugin tab reference from a `/plugin?plugin=<pluginId>&id=<tab>` search string. */
export function pluginTabRefFromSearch(search: string): PluginTabRef {
  const params = new URLSearchParams(search);
  return {
    pluginId: params.get("plugin")?.trim() ?? "",
    id: params.get("id")?.trim() ?? "",
  };
}

export function pluginTabSearch(ref: PluginTabRef): string {
  return `?${new URLSearchParams({ plugin: ref.pluginId, id: ref.id }).toString()}`;
}

export function pluginEntryPointSearch(ref: PluginEntryPointRef): string {
  const params = new URLSearchParams();
  params.set("entry", "1");
  params.set("plugin", ref.pluginId);
  params.set("id", ref.id);
  params.set("path", ref.path);
  params.set("label", ref.label);
  return `?${params.toString()}`;
}

/** Stable key for one tab; ids are only unique per plugin, so both parts matter. */
export function pluginTabKey(ref: PluginTabRef): string {
  return `${ref.pluginId}/${ref.id}`;
}

export function pluginEntryPointKey(ref: Pick<PluginEntryPointRef, "pluginId" | "id" | "path">) {
  return `entry:${ref.pluginId}/${ref.id}/${ref.path}`;
}

export function pluginPageRefFromSearch(search: string): PluginPageRef {
  const tabRef = pluginTabRefFromSearch(search);
  const params = new URLSearchParams(search);
  if (params.get("entry") !== "1") {
    return tabRef;
  }
  return {
    ...tabRef,
    entryPoint: true,
    path: params.get("path")?.trim() ?? "",
    label: params.get("label")?.trim() ?? "",
  };
}

export function pluginNavigationKeyFromSearch(search: string): string {
  const ref = pluginPageRefFromSearch(search);
  return isPluginEntryPointRef(ref) ? pluginEntryPointKey(ref) : pluginTabKey(ref);
}

// One static route hosts every plugin-declared tab; the router only supports
// exact paths, so the tab reference travels in the query like chat sessions.
export const page = definePage({
  id: "plugin",
  path: "/plugin",
  loaderDeps: (_context, location) => location.search,
  loader: (_context, options) => pluginPageRefFromSearch(options.location.search),
  component: () =>
    import("./plugin-page.ts").then(() => ({
      header: true,
      render: (data: unknown) => {
        const ref = (data ?? { pluginId: "", id: "" }) as PluginPageRef;
        return html`<openclaw-plugin-page
          .pluginId=${ref.pluginId}
          .tabId=${ref.id}
          .entryPointPath=${isPluginEntryPointRef(ref) ? ref.path : ""}
          .entryPointLabel=${isPluginEntryPointRef(ref) ? ref.label : ""}
        >
        </openclaw-plugin-page>`;
      },
    })),
});
