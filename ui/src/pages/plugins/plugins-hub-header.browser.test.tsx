import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import {
  CatalogDiscoveryChip,
  CatalogDiscoveryChips,
} from "../../components/solid/catalog-discovery.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import "../../styles.css";
import "../../styles/plugins.css";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { PluginsHubHeader } from "./plugins-hub-header.tsx";

afterEach(() => {
  cleanupSolid();
});

const secondaryAction = { label: "Settings", icon: <Icon name="settings" />, onClick: () => {} };

function header() {
  const view = mountSolid(() => (
    <PluginsHubHeader active="plugins" onSelect={() => {}} secondaryAction={secondaryAction} />
  ));
  const rect = (selector: string) =>
    view.container.querySelector(selector)!.getBoundingClientRect();
  return { tabs: rect(".hub-tabs"), gear: rect(".plugins-hub-header__secondary") };
}

it("keeps the settings gear on the tabs row at phone width", async () => {
  await page.viewport(390, 844);
  const { tabs, gear } = header();
  expect(gear.left).toBeGreaterThanOrEqual(tabs.right);
  expect(gear.top + gear.height / 2).toBeCloseTo(tabs.top + tabs.height / 2, -1);
});

it("keeps the settings gear beside the title on desktop", async () => {
  await page.viewport(1440, 900);
  const { tabs, gear } = header();
  expect(gear.bottom).toBeLessThanOrEqual(tabs.top);
});

it("fades catalog chips only toward the side with more to scroll to", async () => {
  await page.viewport(390, 844);
  const view = mountSolid(() => (
    <CatalogDiscoveryChips label="Categories">
      {Array.from({ length: 12 }, (_, index) => (
        <CatalogDiscoveryChip active={false} onClick={() => {}}>
          {`Category ${index}`}
        </CatalogDiscoveryChip>
      ))}
    </CatalogDiscoveryChips>
  ));
  const chips = view.container.querySelector<HTMLElement>(".plugin-catalog-chips")!;
  const mask = () => getComputedStyle(chips).maskImage;
  await waitForSolid(() => expect(chips.dataset.atEnd).toBe("false"));
  expect(mask()).toMatch(/^linear-gradient\(to right, rgb\(0, 0, 0\)/);

  chips.scrollLeft = 100;
  await waitForSolid(() => expect(chips.dataset.atStart).toBe("false"));
  expect(mask()).toMatch(/^linear-gradient\(to right, rgba\(0, 0, 0, 0\), rgb\(0, 0, 0\) 32px, /);

  chips.scrollLeft = chips.scrollWidth;
  await waitForSolid(() => expect(chips.dataset.atEnd).toBe("true"));
  expect(mask()).toMatch(/^linear-gradient\(to right, rgba\(0, 0, 0, 0\), rgb\(0, 0, 0\) 32px\)$/);
});
