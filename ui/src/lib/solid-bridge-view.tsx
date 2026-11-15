import type { ApplicationContext } from "../app/context.ts";
import type { ShellLayoutOwner } from "../app/shell-layout-owner.ts";
import { ShellLayoutProvider } from "../app/shell-layout-traits-solid.tsx";
import type { JSX } from "../types/solid-elements.d.ts";
import { ApplicationProvider } from "./reactive/context.ts";

export function renderSolidBridgeView(
  Content: () => JSX.Element,
  application: ApplicationContext | undefined,
  layout: ShellLayoutOwner | undefined,
  host: HTMLElement,
): JSX.Element {
  // The component boundary keeps provider child memos out of content setup reads.
  const contentView = () =>
    layout ? (
      <ShellLayoutProvider value={{ owner: layout, host }}>
        <Content />
      </ShellLayoutProvider>
    ) : (
      <Content />
    );
  return application ? (
    <ApplicationProvider value={application}>{contentView()}</ApplicationProvider>
  ) : (
    contentView()
  );
}
