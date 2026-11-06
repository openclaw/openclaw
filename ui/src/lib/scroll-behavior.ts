export function resolveScrollBehavior(behavior: ScrollBehavior = "smooth"): ScrollBehavior {
  return behavior === "smooth" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : behavior;
}
