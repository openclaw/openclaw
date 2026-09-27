import { html, render } from "lit";
import { expect, it, vi } from "vitest";
import { renderSecurity } from "./security.ts";

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
    try {
      render(
        renderSecurity({
          security: {
            gatewayAuth: "token",
            execPolicy: "allowlist",
            browserEnabled: true,
            browserEnabledOverridden: false,
            toolProfile: profile,
            toolProfileOverridden: profile !== "",
          },
          configBusy: busy,
          canPairDevice: false,
          onToolProfileChange,
          editor: html``,
        }),
        container,
      );
      const group = container.querySelector("wa-radio-group")!;
      const radios = [...container.querySelectorAll("wa-radio")];
      await group.updateComplete;
      await Promise.all(radios.map((radio) => radio.updateComplete));
      expect(radios).toHaveLength(4);
      expect(radios.filter((radio) => radio.checked)).toHaveLength(profile ? 1 : 0);
      expect(onToolProfileChange).not.toHaveBeenCalled();
      if (input === "mouse") {
        await page.elementLocator(container.querySelector('wa-radio[value="full"]')!).click();
      } else {
        group.focus();
        if (!profile) {
          await userEvent.keyboard("{ArrowLeft}");
        }
        await userEvent.keyboard(" ");
      }
      await group.updateComplete;
      expect(onToolProfileChange).toHaveBeenCalledTimes(writes);
      if (writes) {
        expect(onToolProfileChange).toHaveBeenCalledWith("full");
        expect(group.value).toBe("full");
      }
    } finally {
      render(null, container);
      container.remove();
    }
  },
);
