export function renderMenuTrigger(
  position: { x: number; y: number },
  label: string,
  edge: "top" | "bottom" = "top",
) {
  return (
    <button
      slot="trigger"
      type="button"
      tabindex={-1}
      aria-hidden="true"
      aria-label={label}
      style={{
        position: "fixed",
        left: `${position.x}px`,
        [edge]: `${position.y}px`,
        width: "1px",
        height: "1px",
        opacity: 0,
        "pointer-events": "none",
      }}
    />
  );
}
