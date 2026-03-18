import { describe, it, expect } from "vitest";
import { createNacosConfigSource } from "./nacos.js";
import type { NacosConfigClient } from "./nacos-client.js";

describe("createNacosConfigSource", () => {
  it("returns source with kind nacos, watchPath null, subscribe function, and readSnapshot builds snapshot", async () => {
    const mockClient: NacosConfigClient = {
      fetchConfig: async () => '{"gateway":{"mode":"local"}}',
      subscribe: () => () => {},
    };
    const source = createNacosConfigSource({
      serverAddr: "http://localhost:8848",
      dataId: "openclaw.json",
      group: "DEFAULT_GROUP",
      env: process.env,
      nacosClient: mockClient,
    });

    expect(source.kind).toBe("nacos");
    expect(source.watchPath).toBeNull();
    expect(typeof source.subscribe).toBe("function");

    const snap = await source.readSnapshot();
    expect(snap.config?.gateway?.mode).toBe("local");
    expect(snap.valid).toBe(true);
    expect(snap.path).toBe("nacos:openclaw.json");
  });
});
