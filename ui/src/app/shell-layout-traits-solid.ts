import { onCleanup, onSettled } from "solid-js";
import { createShellLayoutTraitsReporter, type ShellLayoutTraits } from "./shell-layout-traits.ts";

/** Register after insertion; the shell remains the only owner of content classes. */
export function shellLayoutTraitsRef(traits: ShellLayoutTraits) {
  const reporter = createShellLayoutTraitsReporter();
  let host: Element | undefined;
  onSettled(() => {
    if (host) {
      reporter.publish(host, traits);
    }
  });
  onCleanup(() => reporter.clear());
  return (element: Element) => {
    host = element;
  };
}
