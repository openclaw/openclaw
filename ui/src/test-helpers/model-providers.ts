import { expect } from "vitest";
import type {
  ModelAuthStatusProfile,
  ModelAuthStatusResult,
  ProviderLoginOption,
} from "../api/types.ts";
import { waitForSolid } from "./solid-settle.ts";

type Capability = NonNullable<ModelAuthStatusResult["providerCapabilities"]>[number];

export function capability(provider: string, overrides: Partial<Capability> = {}): Capability {
  return { provider, apiKeySupported: false, quickApiKeySetup: false, ...overrides };
}

export function loginOption(
  id: string,
  brandId: string,
  label: string,
  kind: ProviderLoginOption["kind"],
  overrides: Partial<ProviderLoginOption> = {},
): ProviderLoginOption {
  return { id, brandId, label, kind, featured: false, ...overrides };
}

export function profile(
  profileId: string,
  overrides: Partial<ModelAuthStatusProfile> = {},
): ModelAuthStatusProfile {
  return { profileId, type: "oauth", status: "ok", ...overrides };
}

export function click(root: Pick<ParentNode, "querySelector">, selector: string) {
  root.querySelector<HTMLElement>(selector)!.click();
}

export function expectPresent(root: Pick<ParentNode, "querySelector">, ...selectors: string[]) {
  for (const selector of selectors) {
    expect(root.querySelector(selector), selector).not.toBeNull();
  }
}

export function expectAbsent(root: Pick<ParentNode, "querySelector">, ...selectors: string[]) {
  for (const selector of selectors) {
    expect(root.querySelector(selector), selector).toBeNull();
  }
}

export function expectDisabled(
  root: Pick<ParentNode, "querySelector">,
  selector: string,
  disabled: boolean,
) {
  expect(root.querySelector<HTMLButtonElement | HTMLInputElement>(selector)?.disabled).toBe(
    disabled,
  );
}

export function expectContent(
  element: Pick<Node, "textContent"> | null | undefined,
  includes: string[] = [],
  excludes: string[] = [],
) {
  for (const text of includes) {
    expect(element?.textContent).toContain(text);
  }
  for (const text of excludes) {
    expect(element?.textContent).not.toContain(text);
  }
}

export async function waitForText(
  root: Pick<ParentNode, "querySelector">,
  selector: string,
  text: string,
) {
  await waitForSolid(() => expectContent(root.querySelector(selector), [text]));
}
