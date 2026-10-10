import { render } from "@solidjs/testing-library";
import { ReactiveElement } from "lit";
import { createSignal, flush, onSettled } from "solid-js";
import type { ControlUiReadinessOutlet } from "./control-ui-readiness.ts";
import { RouterOutlet, type RouterOutletProps } from "./router-outlet.tsx";

type Inputs = {
  router: unknown;
  retryContext?: unknown;
  retentionScope?: object;
};

export type MountedRouterOutlet = ControlUiReadinessOutlet & {
  setInputs(inputs: Partial<Inputs>): void;
  dispose(): void;
};

const mounts = new Set<MountedRouterOutlet>();

export function mountRouterOutlet(inputs: Inputs): MountedRouterOutlet {
  // These fixtures use a smaller synthetic route/context union than the app.
  const [props, setProps] = createSignal(inputs as RouterOutletProps);
  const view = render(() => <RouterOutlet {...props()} />);
  const host = view.container.querySelector<ControlUiReadinessOutlet>("openclaw-router-outlet");
  if (!host) {
    throw new Error("Solid did not mount the router outlet");
  }
  const mounted = Object.assign(host, {
    setInputs(next: Partial<Inputs>) {
      setProps((previous) => ({ ...previous, ...next }) as RouterOutletProps);
      flush();
    },
    dispose() {
      view.unmount();
      mounts.delete(mounted);
    },
  });
  mounts.add(mounted);
  return mounted;
}

export function disposeRouterOutlets(): void {
  for (const outlet of mounts) {
    outlet.dispose();
  }
}

export async function settleRouterOutlet(outlet: ControlUiReadinessOutlet): Promise<void> {
  flush();
  await new Promise<void>((resolve) => {
    onSettled(resolve);
  });
  // Test fixtures may inspect descendants; production readiness stops at the outlet.
  const elements = [...outlet.querySelectorAll("*")].filter(
    (element): element is ReactiveElement => element instanceof ReactiveElement,
  );
  await Promise.all(elements.map((element) => element.updateComplete));
  flush();
  await new Promise<void>((resolve) => {
    onSettled(resolve);
  });
}
