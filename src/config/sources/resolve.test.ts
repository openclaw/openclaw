import { describe, it, expect } from "vitest";
import { resolveConfigSource } from "./resolve.js";

describe("resolveConfigSource", () => {
  it("returns file source when OPENCLAW_CONFIG_SOURCE is unset", () => {
    const source = resolveConfigSource({});
    expect(source.kind).toBe("file");
    expect(source.watchPath).toBeDefined();
  });

  it("returns file source when OPENCLAW_CONFIG_SOURCE is not nacos", () => {
    const source = resolveConfigSource({
      OPENCLAW_CONFIG_SOURCE: "file",
    } as NodeJS.ProcessEnv);
    expect(source.kind).toBe("file");
    expect(source.watchPath).toBeDefined();
  });

  it("returns nacos source when OPENCLAW_CONFIG_SOURCE=nacos and Nacos env set", () => {
    const env = {
      OPENCLAW_CONFIG_SOURCE: "nacos",
      NACOS_SERVER_ADDR: "http://nacos:8848",
      NACOS_DATA_ID: "openclaw.json",
      NACOS_GROUP: "DEFAULT_GROUP",
    };
    const source = resolveConfigSource(env as NodeJS.ProcessEnv);
    expect(source.kind).toBe("nacos");
    expect(source.watchPath).toBeNull();
  });

  it("returns file source when OPENCLAW_CONFIG_SOURCE=nacos but Nacos env vars missing", () => {
    const source = resolveConfigSource({
      OPENCLAW_CONFIG_SOURCE: "nacos",
    } as NodeJS.ProcessEnv);
    expect(source.kind).toBe("file");
    expect(source.watchPath).toBeDefined();
  });
});
