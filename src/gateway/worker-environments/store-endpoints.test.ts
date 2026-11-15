import { describe, expect, it } from "vitest";
import type { WorkerSshEndpoint as WorkerEnvironmentSshEndpoint } from "../../plugins/types.js";
import { normalizeWorkerSshEndpoint } from "./store-validation.js";

const HOST_KEY = ["ssh-ed25519", "AAAA"].join(" ");
const SSH_ENDPOINT: WorkerEnvironmentSshEndpoint = {
  host: "worker.example.test",
  port: 2222,
  fallbackPorts: [22, 2200],
  user: "openclaw",
  hostKey: HOST_KEY,
  keyRef: {
    source: "file",
    provider: "worker-keys",
    id: "/static-development-key",
  },
};

describe("worker endpoint normalization", () => {
  it("normalizes provider-advertised SSH fallback ports at the durable boundary", () => {
    expect(
      normalizeWorkerSshEndpoint({
        ...SSH_ENDPOINT,
        fallbackPorts: [22, 2200, 22, 2222],
      }),
    ).toEqual(SSH_ENDPOINT);
  });

  it.each([
    ["non-array", "22"],
    ["non-integer", [22.5]],
    ["below range", [0]],
    ["above range", [65_536]],
    ["more than ten", Array.from({ length: 11 }, (_, index) => 2300 + index)],
  ])("rejects %s SSH fallback ports", (_name, fallbackPorts) => {
    expect(() =>
      normalizeWorkerSshEndpoint({
        ...SSH_ENDPOINT,
        fallbackPorts,
      } as unknown as WorkerEnvironmentSshEndpoint),
    ).toThrow("SSH fallback ports");
  });
});
