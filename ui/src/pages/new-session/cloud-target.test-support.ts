import { createComponent, createSignal, flush } from "solid-js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { CloudProfileMenuItems } from "./cloud-target-view.tsx";

type CloudProfileMenuItemsOptions = Parameters<typeof CloudProfileMenuItems>[0]["params"];

export function mountCloudProfiles(initial: CloudProfileMenuItemsOptions, container: HTMLElement) {
  const [params, setParams] = createSignal(initial);
  const mounted = mountSolid(
    () =>
      createComponent(CloudProfileMenuItems, {
        get params() {
          return params();
        },
      }),
    { container },
  );
  return {
    ...mounted,
    update: (next: CloudProfileMenuItemsOptions) => {
      setParams(next);
      flush();
    },
  };
}
