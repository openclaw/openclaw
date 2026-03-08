import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePeers } from "./peer-relay.js";

function buildConfig(peers?: Array<Record<string, unknown>>, port?: number): OpenClawConfig {
  return {
    gateway: {
      port: port ?? 18789,
      peers,
    },
  } as unknown as OpenClawConfig;
}

describe("resolvePeers", () => {
  it("returns empty array when no peers configured", () => {
    const result = resolvePeers(buildConfig());
    expect(result).toEqual([]);
  });

  it("returns empty array when peers is empty array", () => {
    const result = resolvePeers(buildConfig([]));
    expect(result).toEqual([]);
  });

  it("resolves valid peer entries", () => {
    const result = resolvePeers(
      buildConfig([
        { url: "ws://127.0.0.1:18790", token: "tok-a", name: "kairos" },
        { url: "ws://127.0.0.1:18791", name: "maia", agentIds: ["main"] },
      ]),
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      url: "ws://127.0.0.1:18790",
      token: "tok-a",
      name: "kairos",
      agentIds: undefined,
    });
    expect(result[1]).toEqual({
      url: "ws://127.0.0.1:18791",
      token: undefined,
      name: "maia",
      agentIds: ["main"],
    });
  });

  it("skips entries without a url", () => {
    const result = resolvePeers(
      buildConfig([
        { name: "no-url" },
        { url: "", name: "empty-url" },
        { url: "ws://127.0.0.1:18790", name: "valid" },
      ]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid");
  });

  it("skips self-referencing peers (same port on loopback)", () => {
    const result = resolvePeers(
      buildConfig(
        [
          { url: "ws://127.0.0.1:18789", name: "self" },
          { url: "ws://localhost:18789", name: "self-localhost" },
          { url: "ws://127.0.0.1:18790", name: "other" },
        ],
        18789,
      ),
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("other");
  });

  it("generates default names for unnamed peers", () => {
    const result = resolvePeers(
      buildConfig([{ url: "ws://127.0.0.1:18790" }, { url: "ws://127.0.0.1:18791" }]),
    );
    expect(result[0].name).toBe("peer-0");
    expect(result[1].name).toBe("peer-1");
  });

  it("trims whitespace from url and token", () => {
    const result = resolvePeers(
      buildConfig([{ url: "  ws://127.0.0.1:18790  ", token: "  tok  ", name: "  spaced  " }]),
    );
    expect(result[0].url).toBe("ws://127.0.0.1:18790");
    expect(result[0].token).toBe("tok");
    expect(result[0].name).toBe("spaced");
  });

  it("handles non-string token gracefully", () => {
    const result = resolvePeers(buildConfig([{ url: "ws://127.0.0.1:18790", token: 123 }]));
    expect(result[0].token).toBeUndefined();
  });

  it("filters empty strings from agentIds", () => {
    const result = resolvePeers(
      buildConfig([{ url: "ws://127.0.0.1:18790", agentIds: ["main", "", "growth"] }]),
    );
    expect(result[0].agentIds).toEqual(["main", "growth"]);
  });
});
