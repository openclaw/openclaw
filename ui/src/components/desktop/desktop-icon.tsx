import { For } from "solid-js";
import { StrokeIcon } from "../solid/stroke-icon.tsx";

// Desktop-only glyphs keep the established expand/restore icons and other panels unchanged.
const paths = {
  fullscreen: [
    "M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3",
  ],
  "exit-fullscreen": [
    "M8 3v3a2 2 0 0 1-2 2H3m13-5v3a2 2 0 0 0 2 2h3M3 16h3a2 2 0 0 1 2 2v3m8 0v-3a2 2 0 0 1 2-2h3",
  ],
  fit: [
    "M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3",
  ],
  actual: [
    "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
    "M6 9h.01M18 15h.01",
  ],
  "fit-height": ["m8 6 4-4 4 4M12 2v20m-4-4 4 4 4-4"],
  "fit-width": ["m6 8-4 4 4 4M2 12h20m-4-4 4 4-4 4"],
  match: [
    "M12 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v6M12 17v4M8 21h4",
    "M19 14v-1m0 9v-1m-4-4h-1m9 0h-1m-5.8-2.8-.7-.7m7 7-.7-.7m-5.6 0-.7.7m7-7-.7.7",
    "M21 17a2 2 0 1 0-4 0 2 2 0 0 0 4 0",
  ],
  disconnect: [
    "m19 5 3-3M2 22l3-3M6.3 20.3l-2.6-2.6a1 1 0 0 1 0-1.4l3.6-3.6a1 1 0 0 1 1.4 0l2.6 2.6a1 1 0 0 1 0 1.4l-3.6 3.6a1 1 0 0 1-1.4 0ZM17.7 3.7l2.6 2.6a1 1 0 0 1 0 1.4l-3.6 3.6a1 1 0 0 1-1.4 0l-2.6-2.6a1 1 0 0 1 0-1.4l3.6-3.6a1 1 0 0 1 1.4 0ZM9 11l2-2m2 6 2-2",
  ],
};

export function DesktopIcon(props: { name: keyof typeof paths }) {
  return (
    <StrokeIcon stroke-width="1.65" aria-hidden="true">
      <For each={paths[props.name]}>{(d) => <path d={d} />}</For>
    </StrokeIcon>
  );
}
