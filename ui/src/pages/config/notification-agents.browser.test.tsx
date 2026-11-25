import { expect, it, onTestFinished } from "vitest";
import { page } from "vitest/browser";
import "../../styles.css";
import "../../styles/settings.css";
import "../../styles/select-picker.css";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { NotificationAgentsRow } from "./notification-agents.tsx";
registerEnglishCatalog(registerSettingsEnglish);
it.each([390, 1440])(
  "keeps the inherited agent identity readable inside its notification control at %i pixels",
  async (width) => {
    await page.viewport(width, 900);
    const agent = "northern-hemisphere-spectrograph-production-amber";
    const name = "Observatory calibration and release reviewer";
    const view = mountSolid(() => (
      <div class="settings-group" style={{ width: width === 390 ? "364px" : "726px" }}>
        <NotificationAgentsRow
          inherit
          agentIds={undefined}
          inheritedAgentIds={[agent]}
          agentCatalog={{
            agentsList: {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                { id: agent, name },
                { id: "violet", name },
              ],
            },
            agentsLoading: false,
            agentsError: null,
          }}
          onChange={() => {}}
        />
      </div>
    ));
    onTestFinished(() => view.unmount());
    const button = view.getByRole("button", { name: "Choose notification agents" }),
      label = button.querySelector("span")!,
      control = button.closest(".settings-row__control")!;
    expect(label.textContent).toBe(`Account default: ${name}`);
    expect(button.getAttribute("aria-description")).toContain(agent);
    const bounds = button.getBoundingClientRect(),
      available = control.getBoundingClientRect();
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.left).toBeGreaterThanOrEqual(available.left - 0.5);
    expect(bounds.right).toBeLessThanOrEqual(available.right + 0.5);
    expect(
      Math.abs(
        label.getBoundingClientRect().height -
          Number.parseFloat(getComputedStyle(label).lineHeight),
      ),
    ).toBeLessThan(1);
    expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
    expect(button.querySelector("svg")!.getBoundingClientRect().right).toBeLessThanOrEqual(
      bounds.right,
    );
  },
);
