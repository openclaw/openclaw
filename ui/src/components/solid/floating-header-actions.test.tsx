import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { ShellLayoutOwner } from "../../app/shell-layout-owner.ts";
import { ShellLayoutProvider } from "../../app/shell-layout-traits-solid.tsx";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { FloatingHeaderActions } from "./floating-header-actions.tsx";

afterEach(cleanupSolid);

describe("FloatingHeaderActions", () => {
  it("moves page buttons into the header slot and back with its lifetime", () => {
    const owner = new ShellLayoutOwner();
    const slot = document.createElement("div");
    const view = mountSolid(() => (
      <ShellLayoutProvider value={{ owner, host: document.body }}>
        <FloatingHeaderActions fallback={<button class="inline">Refresh</button>}>
          <button class="in-pill">Refresh</button>
        </FloatingHeaderActions>
      </ShellLayoutProvider>
    ));
    flush();
    expect(view.container.querySelector(".inline")).not.toBeNull();
    expect(slot.querySelector(".in-pill")).toBeNull();

    const release = owner.registerHeaderActions(slot);
    flush();
    expect(view.container.querySelector(".inline")).toBeNull();
    expect(slot.querySelector(".in-pill")).not.toBeNull();

    release();
    flush();
    expect(view.container.querySelector(".inline")).not.toBeNull();
    expect(slot.querySelector(".in-pill")).toBeNull();
  });
});
