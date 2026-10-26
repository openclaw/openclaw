import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { SessionMenuItem } from "./cloud-target-view.tsx";
import { mountCloudProfiles } from "./cloud-target.test-support.ts";

function mountSessionItem(item: Parameters<typeof SessionMenuItem>[0]["item"]) {
  return mountSolid(() => createComponent(SessionMenuItem, { item, submitting: false }), {
    container,
  });
}

const container = document.createElement("div");
document.body.append(container);

afterEach(cleanupSolid);

const blockedProvider = "Default, Cloud worker provider: custom-worker, Capacity exhausted";

async function expectChoice(name: string, description: string | RegExp) {
  const choice = page.getByRole("button", { name, exact: true });
  await expect.element(choice).toHaveAccessibleName(name);
  await expect.element(choice).toHaveAccessibleDescription(description);
  return choice;
}

describe("cloud target accessibility", () => {
  it.each([
    { providerId: "crabbox", providerDisplayId: "azure", provider: "Azure" },
    { providerId: "custom-worker", providerDisplayId: undefined, provider: "custom-worker" },
  ])("keeps cloud profile names separate from $provider descriptions", async (profile) => {
    const params = {
      profiles: [{ id: "aws", ...profile, trust: "persistent" as const }],
      selectedId: "",
      submitting: false,
      onSelect: vi.fn(),
    };
    const { update } = mountCloudProfiles(params, container);
    await expectChoice("aws", `Cloud worker provider: ${profile.provider}`);

    update({ ...params, profiles: [{ ...params.profiles[0]!, id: "production" }] });
    await expectChoice("production", `Cloud worker provider: ${profile.provider}`);
  });

  it("retains the provider in the configuration tooltip description", async () => {
    mountCloudProfiles(
      {
        profiles: [
          {
            id: "production",
            providerId: "crabbox",
            providerDisplayId: "aws",
            operatingSystems: [
              { id: "linux", label: "Linux", default: true },
              { id: "windows", label: "Windows" },
            ],
            machines: [{ id: "standard", label: "Standard", default: true }],
          },
        ],
        selectedId: "production",
        submitting: false,
        onSelect: vi.fn(),
      },
      container,
    );
    const choice = await expectChoice("production Linux · Standard", /Cloud worker provider: AWS/);
    await expect
      .element(choice)
      .toHaveAccessibleDescription(/Operating system.*Linux.*Windows.*Machine.*Standard/);
    await choice.click();
    await expectChoice("production Linux · Standard", /Cloud worker provider: AWS/);
  });

  it.each([
    [true, false, false, "AWS", "Cloud worker provider: AWS, production"],
    [false, true, false, "AWS", "Default, Cloud worker provider: AWS"],
    [false, true, true, "custom-worker", blockedProvider],
    [true, true, true, "custom-worker", blockedProvider],
    [false, true, false, undefined, "Default"],
    [true, false, true, undefined, "Capacity exhausted"],
  ] as const)(
    "preserves hints and blockers (compact: %s, suggested: %s, disabled: %s, provider: %s)",
    async (compact, suggested, disabled, provider, expected) => {
      const onSelect = vi.fn();
      mountSessionItem({
        value: "cloud:production",
        label: "production",
        selectedSummary: "Linux · Standard",
        accessibleProvider: provider,
        compact,
        suggested,
        disabled,
        title: disabled ? "Capacity exhausted" : undefined,
        checked: false,
        onSelect,
      });
      const name =
        compact && disabled
          ? "production Linux · Standard Unavailable"
          : "production Linux · Standard";
      const choice = await expectChoice(name, expected);
      if (disabled) {
        container.querySelector<HTMLButtonElement>("[data-value]")!.click();
        expect(onSelect).not.toHaveBeenCalled();
      } else {
        await choice.click();
        expect(onSelect).toHaveBeenCalledOnce();
      }
    },
  );
});
