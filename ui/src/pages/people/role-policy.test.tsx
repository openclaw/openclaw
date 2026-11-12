/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { RolePolicy } from "./role-policy.tsx";

registerEnglishCatalog(registerProfileEnglish);
const base = { agents: ["main"], sessions: { others: "view" }, scopes: ["operator.sessions.read"] };
function facts(policy: Record<string, unknown>) {
  const page = mountSolid(() => <RolePolicy name="visitor" policy={policy} />);
  const value = (title: string) =>
    [...page.container.querySelectorAll(".settings-row")]
      .find((row) => row.querySelector(".settings-row__title")?.textContent === title)
      ?.querySelector(".settings-row__value")?.textContent;
  return { page, value };
}

it("summarizes configured scopes, model restrictions and required policy before technical disclosure", () => {
  const { page, value } = facts({
    ...base,
    modelPolicy: {
      sourceAgent: "shared",
      allow: ["provider/allowed-*"],
      deny: ["provider/allowed-private"],
    },
    accessPolicyPlugin: "visitor-access",
  });
  expect(value("Operator scope ceiling")).toBe("operator.sessions.read");
  expect(value("Model source")).toBe("shared");
  expect(value("Allowed models")).toBe("provider/allowed-*");
  expect(value("Excluded models")).toBe("provider/allowed-private");
  expect(value("Required access policy")).toBe("visitor-access");
  const details = page.container.querySelector("details")!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain("accessPolicyPlugin");
});

it.each([
  { policy: {}, allowed: "No role-specific model restriction", source: undefined },
  {
    policy: { modelPolicy: {} },
    allowed: "Source agent’s primary and fallback models",
    source: "Configured system, default, or sole agent",
  },
  {
    policy: { modelPolicy: { allow: [] } },
    allowed: "No models permitted",
    source: "Configured system, default, or sole agent",
  },
])(
  "distinguishes omitted model policy, inherited source and an empty allow list: $allowed",
  ({ policy, allowed, source }) => {
    const { value } = facts({ ...base, ...policy });
    expect(value("Allowed models")).toBe(allowed);
    expect(value("Model source")).toBe(source);
    expect(value("Required access policy")).toBe("No role-specific plugin requirement");
  },
);

it("keeps a missing configured scope ceiling distinct from an explicitly empty one", () => {
  const missing = facts({ agents: [], sessions: { others: "none" } });
  expect(missing.value("Operator scope ceiling")).toBe("Not reported");
  const empty = facts({ ...base, scopes: [] });
  expect(empty.value("Operator scope ceiling")).toBe("None");
});
