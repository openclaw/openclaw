import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { Security } from "./security.tsx";

it.each([
  { profile: "", busy: false, input: "keyboard", writes: 1 },
  { profile: "", busy: false, input: "mouse", writes: 1 },
  { profile: "full", busy: false, input: "keyboard", writes: 0 },
  { profile: "", busy: true, input: "keyboard", writes: 0 },
])(
  "selects Security Full from '$profile' with $input while busy=$busy",
  async ({ profile, busy, input, writes }) => {
    const { page, userEvent } = await import("vitest/browser");
    const container = document.createElement("div");
    const onToolProfileChange = vi.fn();
    document.body.append(container);
    const { unmount } = mountSolid(
      () => (
        <Security
          security={{
            gatewayAuth: "token",
            execPolicy: "allowlist",
            browserEnabled: true,
            browserEnabledOverridden: false,
            toolProfile: profile,
            toolProfileOverridden: profile !== "",
          }}
          configBusy={busy}
          canPairDevice={false}
          onToolProfileChange={onToolProfileChange}
          editor={undefined}
        />
      ),
      { container },
    );
    try {
      const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
      expect(radios).toHaveLength(4);
      expect(radios.filter((radio) => radio.checked)).toHaveLength(profile ? 1 : 0);
      expect(onToolProfileChange).not.toHaveBeenCalled();
      const full = container.querySelector<HTMLInputElement>('input[type="radio"][value="full"]')!;
      if (input === "mouse") {
        await page.elementLocator(full).click();
      } else {
        full.focus();
        await userEvent.keyboard(" ");
      }
      flush();
      expect(onToolProfileChange).toHaveBeenCalledTimes(writes);
      if (writes) {
        expect(onToolProfileChange).toHaveBeenCalledWith("full");
        expect(full.checked).toBe(true);
      }
    } finally {
      unmount();
      container.remove();
    }
  },
);
