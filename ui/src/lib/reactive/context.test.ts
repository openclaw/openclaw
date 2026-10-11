import { ContextNotFoundError, createRoot } from "@solidjs/signals";
import { render } from "@solidjs/web";
import { createComponent } from "solid-js";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../../app/context-types.ts";
import { ApplicationProvider, useApplication, useOptionalApplication } from "./context.ts";

it("passes the same application capability object through nested owned providers", () => {
  // Context transport treats capabilities as opaque; no owner method is invoked here.
  const outer = { basePath: "/outer" } as ApplicationContext;
  const inner = { basePath: "/inner" } as ApplicationContext;
  const seen: ApplicationContext[] = [];
  const container = document.createElement("div");
  const dispose = render(
    () =>
      createComponent(ApplicationProvider, {
        value: outer,
        get children() {
          expect(useOptionalApplication()).toBe(outer);
          seen.push(useApplication());
          return createComponent(ApplicationProvider, {
            value: inner,
            get children() {
              expect(useOptionalApplication()).toBe(inner);
              seen.push(useApplication());
              return useApplication().basePath;
            },
          });
        },
      }),
    container,
  );
  try {
    expect(seen[0]).toBe(outer);
    expect(seen[1]).toBe(inner);
    expect(container.textContent).toBe("/inner");
    createRoot((stop) => {
      expect(useOptionalApplication()).toBeUndefined();
      expect(() => useApplication()).toThrow(ContextNotFoundError);
      stop();
    });
  } finally {
    dispose();
  }
});
