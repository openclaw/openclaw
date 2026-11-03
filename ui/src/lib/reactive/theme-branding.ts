import { currentThemeBranding, subscribeThemeBranding } from "../../app/theme-branding.ts";
import { createDetachedRoot } from "./detached-root.ts";
import { projectSource } from "./projection.ts";

// The branding module owns one publication stream, shared across every rendered surface.
export const themeBrandingProjection = createDetachedRoot(() => {
  const shared = projectSource(null, {
    read: currentThemeBranding,
    subscribe: (_source, notify) => subscribeThemeBranding(notify),
    equality: Object.is,
  });
  return { read: shared.read, revision: shared.revision };
});
