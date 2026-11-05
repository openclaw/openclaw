export const DETAILS_SECTION_MOTION = {
  duration: 300,
  easing: "cubic-bezier(0.2, 1, 0.22, 1)",
};

type DetailsSectionMotion = {
  from: { height: number; opacity: string; marginTop: string };
  height: number;
  expanded: boolean;
  reduced: boolean;
};

/** Shared painted transition; each native disclosure retains its choice and lifecycle. */
export function animateDetailsSection(body: HTMLElement, motion: DetailsSectionMotion) {
  const to = {
    height: `${motion.height}px`,
    opacity: motion.expanded ? 1 : 0,
    marginTop: motion.expanded ? "2px" : "0px",
  };
  return body.animate(
    motion.reduced
      ? [{ opacity: motion.from.opacity }, { opacity: to.opacity }]
      : [{ ...motion.from, height: `${motion.from.height}px` }, to],
    { ...DETAILS_SECTION_MOTION, duration: motion.reduced ? 100 : DETAILS_SECTION_MOTION.duration },
  );
}
