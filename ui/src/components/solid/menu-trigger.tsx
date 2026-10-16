export function pointMenuTriggerAttributes(
  position: { x: number; y: number | undefined },
  edge: "top" | "bottom" = "top",
) {
  return {
    tabindex: -1,
    "aria-hidden": "true" as const,
    style: {
      position: "fixed" as const,
      left: `${position.x}px`,
      [edge]: `${position.y}px`,
      width: "1px",
      height: "1px",
      opacity: 0,
      "pointer-events": "none" as const,
    },
  };
}

export function renderMenuTrigger(
  position: { x: number; y: number },
  label: string,
  edge: "top" | "bottom" = "top",
) {
  return (
    <button
      {...pointMenuTriggerAttributes(position, edge)}
      slot="trigger"
      type="button"
      aria-label={label}
    />
  );
}
