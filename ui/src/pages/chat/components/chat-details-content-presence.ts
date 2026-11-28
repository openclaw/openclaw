import { createContext, onSettled, useContext } from "solid-js";

/** Only real sections and actionable errors contribute to the desktop Details control. */
export const DesktopDetailsContent = createContext<(() => () => void) | null>(null);

export function ReportDesktopDetailsContent() {
  const retain = useContext(DesktopDetailsContent);
  if (retain) {
    onSettled(retain);
  }
  return null;
}
