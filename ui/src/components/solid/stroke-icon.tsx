import type { JSX } from "@solidjs/web";

export function StrokeIcon(props: JSX.IntrinsicElements["svg"]) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      {...props}
    >
      {props.children}
    </svg>
  );
}
