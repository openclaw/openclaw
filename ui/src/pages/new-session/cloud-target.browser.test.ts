import { createComponent } from "solid-js";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { SessionMenuItem } from "./cloud-target-view.tsx";
import { mountCloudProfiles } from "./cloud-target.test-support.ts";

const container = document.createElement("div");
document.body.append(container);

const blockedProvider = "Default, Cloud worker provider: custom-worker, Capacity exhausted";

async function expectChoice(name: string, description: string | RegExp) {
  const choice = page.getByRole("button", { name, exact: true });
  await expect.element(choice).toHaveAccessibleDescription(description);
  return choice;
}

it.each([
  { providerId: "crabbox", providerDisplayId: "azure", provider: "Azure" },
  { providerId: "custom-worker", providerDisplayId: undefined, provider: "custom-worker" },
])("keeps $provider descriptions through profile rename and configuration", async (profile) => {
  const params = {
    profiles: [{ id: "aws", ...profile, trust: "persistent" as const }],
    selectedId: "",
    submitting: false,
    onSelect: vi.fn(),
  };
  const { update } = mountCloudProfiles(params, container);
  await expectChoice("aws", `Cloud worker provider: ${profile.provider}`);

  const production = { ...params.profiles[0]!, id: "production" };
  update({ ...params, profiles: [production] });
  await expectChoice("production", `Cloud worker provider: ${profile.provider}`);
  if (profile.providerId === "crabbox") {
    const configured = {
      ...production,
      operatingSystems: [
        { id: "linux", label: "Linux", default: true },
        { id: "windows", label: "Windows" },
      ],
      machines: [{ id: "standard", label: "Standard", default: true }],
    };
    update({ ...params, profiles: [configured], selectedId: "production" });
    const choice = page.getByRole("button", { name: "production Linux · Standard", exact: true });
    await expect
      .element(choice)
      .toHaveAccessibleDescription(/Operating system.*Linux.*Windows.*Machine.*Standard/);
    await choice.click();
    await expectChoice("production Linux · Standard", /Cloud worker provider: Azure/);
  }
});

it.each([
  [true, false, false, "AWS", "Cloud worker provider: AWS, production"],
  [false, true, false, "AWS", "Default, Cloud worker provider: AWS"],
  [false, true, true, "custom-worker", blockedProvider],
  [true, true, true, "custom-worker", blockedProvider],
  [true, false, true, undefined, "Capacity exhausted"],
] as const)(
  "preserves hints and blockers (compact: %s, suggested: %s, disabled: %s, provider: %s)",
  async (compact, suggested, disabled, provider, expected) => {
    const onSelect = vi.fn();
    const item = {
      value: "cloud:production",
      label: "production",
      accessibleProvider: provider,
      compact,
      suggested,
      disabled,
      title: disabled ? "Capacity exhausted" : undefined,
      checked: false,
      onSelect,
    };
    mountSolid(() => createComponent(SessionMenuItem, { item, submitting: false }), {
      container,
    });
    const name = compact && disabled ? "production Unavailable" : "production";
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
