import { validateToolArguments } from "@openclaw/ai/validation";
import { expect, it, vi } from "vitest";
import { createSessionsTool } from "./sessions-tool.js";

it("pages cloud profile summaries and returns the selected OS/machine catalog", async () => {
  const profiles = Array.from({ length: 33 }, (_, index) => ({
    id: "profile-" + index,
    providerId: "fixture",
    operatingSystems: [{ id: "linux", label: "Linux", default: true }],
    machines: [{ id: "tiny", label: "Tiny", os: "linux", cpu: 2 }],
  }));
  const callGateway = vi
    .fn()
    .mockResolvedValue({ environments: [{ id: "private-worker" }], profiles });
  const tool = createSessionsTool({ senderIsOwner: true, callGateway });
  const first = await tool.execute("catalog", { action: "cloud_profiles" });
  expect(first.details).toMatchObject({
    profiles: profiles.slice(0, 32).map(({ id, providerId }) => ({ id, providerId })),
    nextOffset: 32,
  });
  expect(first.details).not.toHaveProperty("environments");
  const last = await tool.execute("catalog-page", { action: "cloud_profiles", offset: 32 });
  expect(last.details).toEqual({ profiles: [{ id: "profile-32", providerId: "fixture" }] });
  const selected = await tool.execute("profile", {
    action: "cloud_profiles",
    profileId: "profile-32",
  });
  expect(selected.details).toEqual({ profile: profiles[32] });
  expect(callGateway).toHaveBeenCalledWith({
    method: "environments.list",
    params: { projection: "profiles" },
  });
  const missing = await tool.execute("missing", {
    action: "cloud_profiles",
    profileId: "removed",
  });
  expect(missing.details).toMatchObject({ status: "error", profileId: "removed" });
});

it.each([256, 257])("validates a listed profile ID with %s characters", async (length) => {
  const profile = {
    id: "p".repeat(length),
    providerId: "fixture",
    operatingSystems: [{ id: "linux", label: "Linux", default: true }],
    machines: [{ id: "tiny", label: "Tiny", os: "linux", cpu: 2 }],
  };
  const callGateway = vi.fn().mockResolvedValue({ profiles: [profile] });
  const tool = createSessionsTool({ senderIsOwner: true, callGateway });
  const validate = () =>
    validateToolArguments(tool, {
      type: "toolCall",
      id: "selected-profile",
      name: tool.name,
      arguments: { action: "cloud_profiles", profileId: profile.id },
    });
  if (length === 257) {
    expect(validate).toThrow(/profileId/);
  } else {
    const listed = await tool.execute("catalog", { action: "cloud_profiles" });
    expect(listed.details).toMatchObject({ profiles: [{ id: profile.id }] });
    expect((await tool.execute("selected-profile", validate())).details).toEqual({ profile });
  }
});
