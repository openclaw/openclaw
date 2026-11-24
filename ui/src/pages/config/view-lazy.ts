import { lazy } from "solid-js";

export const HighlightedJson = lazy(() => import("../../components/solid/highlighted-json.tsx"), {
  export: "HighlightedJson",
});

export const ConfigForm = lazy(() => import("../../components/config-form.render.tsx"), {
  export: "ConfigForm",
});
export const NotificationsSection = lazy(() => import("./notifications-section.tsx"), {
  export: "NotificationsSection",
});
export const SetupSection = lazy(() => import("./setup.tsx"), { export: "SetupSection" });

export function preloadConfigSection(section: string | null) {
  if (section === "__appearance__") {
    return Promise.resolve();
  }
  if (section === "__notifications__") {
    return NotificationsSection.preload();
  }
  return Promise.all([ConfigForm.preload(), ...(section === null ? [SetupSection.preload()] : [])]);
}
