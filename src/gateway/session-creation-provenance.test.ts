import { expect, it } from "vitest";
import {
  attachGatewayLocalUserIngress,
  prepareGatewayLocalUserIngress,
} from "./local-user-ingress.js";
import { resolveAgentRunSessionCreation } from "./session-creation-provenance.js";

function prepare(
  input: Omit<Parameters<typeof prepareGatewayLocalUserIngress>[0], "isLocalClient">,
) {
  return prepareGatewayLocalUserIngress({ ...input, isLocalClient: false });
}
const humanRun = (id: string) => ({ via: "run", actor: { type: "human", source: "profile", id } });
const assurance = (kind: string, rawEvidenceRef: string, strength = "boundary-verified") => ({
  kind,
  rawEvidenceRef,
  strength,
});

function resolveWithIngress(
  localUserIngress: ReturnType<typeof prepareGatewayLocalUserIngress>,
  profileId?: string,
) {
  const client = profileId ? { authenticatedUserProfile: { profileId } } : {};
  attachGatewayLocalUserIngress(client, localUserIngress);
  return resolveAgentRunSessionCreation(client);
}

it.each([
  ["profile-ada", "profile-ada"],
  ["profile-before-merge", "profile-after-merge"],
])("uses live profile %s -> %s without retaining its display label", (original, current) => {
  const localUserIngress = prepare({
    authenticatedUserExpected: true,
    profile: { profileId: original, displayName: "Ada" },
  });
  expect(resolveWithIngress(localUserIngress, current)).toEqual(humanRun(current));
  expect(localUserIngress.facts.invoker).toEqual({
    state: "present",
    kind: "person",
    rawPrincipalRef: original,
    displayLabel: "Ada",
  });
});

it("does not infer an actor for a profile-less wire client", () => {
  expect(resolveAgentRunSessionCreation({})).toEqual({ via: "run" });
});

it.each(["device-token", "token"] as const)(
  "keeps %s profile-less and unattributed",
  (authMethod) => {
    const paired = authMethod === "device-token";
    const localUserIngress = prepare({
      authMethod,
      authenticatedUserExpected: false,
      ...(paired ? { pairedDeviceId: "device-browser" } : {}),
    });
    expect(localUserIngress.facts.ingress).toEqual(
      paired
        ? expect.objectContaining({ rawSourceRef: "device-browser" })
        : expect.not.objectContaining({ rawSourceRef: expect.anything() }),
    );
    if (paired) {
      expect(localUserIngress.facts.assurance).toEqual([
        assurance("device-proof", "device-browser", "cryptographic"),
      ]);
    }
    expect(localUserIngress.facts.invoker).toBeUndefined();
    expect(resolveWithIngress(localUserIngress)).toEqual({ via: "run" });
  },
);

it("keeps a trusted-proxy identity unknown when durable profile resolution is missing", () => {
  const localUserIngress = prepare({
    authMethod: "trusted-proxy",
    authenticatedUserExpected: true,
  });

  expect(localUserIngress.facts).toMatchObject({
    ingress: { kind: "gateway-client", state: "present" },
    invoker: { state: "unknown" },
    assurance: [assurance("trusted-proxy", "gateway-auth:trusted-proxy")],
  });
  expect(resolveWithIngress(localUserIngress)).toEqual({ via: "run" });
});

it("records both durable-profile and trusted-proxy assurance for a profiled proxy user", () => {
  const localUserIngress = prepare({
    authMethod: "trusted-proxy",
    authenticatedUserExpected: true,
    profile: { profileId: "profile-proxy", displayName: "Proxy User" },
  });

  expect(localUserIngress.facts.assurance).toEqual([
    assurance("durable-profile", "profile-proxy"),
    assurance("trusted-proxy", "profile-proxy"),
  ]);
});

it("keeps a bounded, redacted profile label transient for opt-in run auditing", () => {
  const secret = "sk-1234567890abcdef";
  const localUserIngress = prepare({
    authenticatedUserExpected: true,
    profile: {
      profileId: "profile-redacted",
      displayName: `Operator OPENAI_API_KEY=${secret} ${"x".repeat(256)}`,
    },
  });

  const invoker = localUserIngress.facts.invoker;
  expect(invoker).toMatchObject({ state: "present" });
  if (invoker?.state !== "present") {
    throw new Error("expected present invoker");
  }
  expect(invoker.displayLabel).toContain("OPENAI_API_KEY=***");
  expect(invoker.displayLabel).not.toContain(secret);
  expect(invoker.displayLabel?.length).toBeLessThanOrEqual(128);
  expect(resolveWithIngress(localUserIngress, "profile-redacted")).toEqual(
    humanRun("profile-redacted"),
  );
});
