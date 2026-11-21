/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { defineSolidPage } from "./app-route-types.tsx";
import { cleanupSolid, mountSolid } from "./test-helpers/mount-solid.ts";
import { waitForSolid } from "./test-helpers/solid-settle.ts";

afterEach(cleanupSolid);

it("loads the page on demand and updates route props without remounting it", async () => {
  let mounts = 0;
  const load = vi.fn(async () => {
    return (props: { routeData: string | undefined; loaderPending: boolean }) => {
      mounts += 1;
      return <span>{`${props.routeData ?? "loading"}:${props.loaderPending}`}</span>;
    };
  });
  const page = defineSolidPage<"agents", unknown, string>("agents", load);
  expect(load).not.toHaveBeenCalled();

  const { renderSolid: Page } = await page.component();
  expect(load).toHaveBeenCalledOnce();
  const [data, setData] = createSignal<string>();
  const [pending, setPending] = createSignal(true);
  const mounted = mountSolid(() => <Page data={data()} loaderPending={pending()} presented />);
  expect(mounted.container.textContent).toBe("loading:true");

  setData("next");
  setPending(false);
  await waitForSolid(() => expect(mounted.container.textContent).toBe("next:false"));
  expect(mounts).toBe(1);
});
