import { expect, test } from "vitest";
import { fingerprint } from "../../packages/openclaw-id-protocol/src/index.js";
import { buildWorld } from "../../packages/openclaw-id-protocol/src/testing/world.js";
import { normalizeGatewayConfig } from "./config-shared.js";

const world = await buildWorld();
const target = {
  hostname: world.binding.body.hostname,
  pin: {
    claw_id: world.binding.body.claw_id,
    root_fp: await fingerprint(world.rootPub),
    binding_seq: 1,
  },
  evidence: { root_pub: world.rootPub, binding: world.binding },
  relayUrl: "https://relay.example/",
};
const normalize = (discoveryUrl?: string) =>
  normalizeGatewayConfig({
    kind: "openclaw-id",
    openclawId: { ...target, discoveryUrl: discoveryUrl! },
  });

test("saved target retains independent Discovery routing without inferring an origin", () => {
  expect(() => normalize()).toThrow("Discovery origin");
  expect(normalize("https://discovery.example/")?.openclawId?.discoveryUrl).toBe(
    "https://discovery.example",
  );
  expect(normalize("http://localhost:8787/")?.openclawId?.discoveryUrl).toBe(
    "http://localhost:8787",
  );
});

test.each([
  "http://remote.example",
  "https://user:pass@api.example",
  "https://api.example/path",
  "https://api.example/?q=1",
  "https://api.example/#x",
])("rejects non-origin Discovery routing %s", (url) => {
  expect(() => normalize(url)).toThrow("Discovery origin");
});
