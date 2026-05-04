import { describe, expect, it } from "vitest";
import { findManagedProxyRuntimeMutationLines } from "../../scripts/check-managed-proxy-runtime-mutation.mjs";

describe("check-managed-proxy-runtime-mutation", () => {
  it("finds assignments and deletes for proxy env vars", () => {
    const source = `
      process.env.HTTP_PROXY = "http://proxy";
      process.env["HTTPS_PROXY"] = "http://proxy";
      delete process.env.NO_PROXY;
      delete process.env["GLOBAL_AGENT_NO_PROXY"];
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([2, 3, 4, 5]);
  });

  it("finds global object alias GLOBAL_AGENT mutations", () => {
    const source = `
      const globalRecord = global;
      const agent = globalRecord.GLOBAL_AGENT;
      globalRecord.GLOBAL_AGENT = {};
      globalRecord["GLOBAL_AGENT"] = {};
      delete globalRecord.GLOBAL_AGENT;
      delete globalRecord["GLOBAL_AGENT"];
      agent.HTTP_PROXY = "http://proxy";
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([4, 5, 6, 7, 8]);
  });

  it("finds GLOBAL_AGENT mutations", () => {
    const source = `
      global.GLOBAL_AGENT = {};
      global.GLOBAL_AGENT.NO_PROXY = "localhost";
      global["GLOBAL_AGENT"].HTTP_PROXY = "http://proxy";
      delete global.GLOBAL_AGENT.HTTPS_PROXY;
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([2, 3, 4, 5]);
  });

  it("finds Object.assign and Object.defineProperty mutations", () => {
    const source = `
      Object.assign(global.GLOBAL_AGENT, { NO_PROXY: "localhost" });
      Object.assign(process.env, { NO_PROXY: "localhost" });
      Object.defineProperty(process.env, "HTTP_PROXY", { value: "http://proxy" });
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([2, 3, 4]);
  });

  it("finds missing managed-proxy env key mutations", () => {
    const source = `
      process.env.GLOBAL_AGENT_FORCE_GLOBAL_AGENT = "true";
      process.env.OPENCLAW_PROXY_LOOPBACK_MODE = "gateway-only";
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([2, 3]);
  });

  it("finds defineProperty mutations with constant proxy keys", () => {
    const source = `
      const proxyKey = "HTTP_PROXY";
      const agentKey = "NO_PROXY";
      Object.defineProperty(process.env, proxyKey, { value: "http://proxy" });
      Object.defineProperty(global.GLOBAL_AGENT, agentKey, { value: "localhost" });
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([4, 5]);
  });

  it("finds destructured process.env alias mutations", () => {
    const source = `
      const { env } = process;
      env.HTTP_PROXY = "http://proxy";
      env["NO_PROXY"] = "localhost";
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([3, 4]);
  });

  it("finds process.env alias and constant key mutations", () => {
    const source = `
      const env = process.env;
      const proxyKey = "HTTP_PROXY";
      env.HTTPS_PROXY = "http://proxy";
      env[proxyKey] = "http://proxy";
      delete env.NO_PROXY;
      Object.assign(env, { GLOBAL_AGENT_HTTP_PROXY: "http://proxy" });
      Object.defineProperty(env, "OPENCLAW_PROXY_ACTIVE", { value: "1" });
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([4, 5, 6, 7, 8]);
  });

  it("finds dynamic process.env key mutations from forbidden key arrays", () => {
    const source = `
      const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
      for (const key of proxyKeys) {
        process.env[key] = "http://proxy";
      }
      for (const key of proxyKeys) {
        delete process.env[key];
      }
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([4, 7]);
  });

  it("finds dynamic process.env key mutations from spread-built forbidden key arrays", () => {
    const source = `
      const lower = ["http_proxy", "https_proxy"];
      const upper = ["HTTP_PROXY", "HTTPS_PROXY"];
      const all = [...lower, ...upper, "OPENCLAW_PROXY_LOOPBACK_MODE"];
      for (const key of all) {
        delete process.env[key];
      }
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([6]);
  });

  it("ignores dynamic process.env key mutations from unrelated key arrays", () => {
    const source = `
      const normalKeys = ["PATH", "HOME"];
      for (const key of normalKeys) {
        process.env[key] = "value";
      }
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([]);
  });

  it("finds GLOBAL_AGENT alias mutations", () => {
    const source = `
      const agent = global.GLOBAL_AGENT;
      agent.HTTP_PROXY = "http://proxy";
      agent["NO_PROXY"] = "localhost";
      delete agent.HTTPS_PROXY;
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([3, 4, 5]);
  });

  it("finds globalThis.GLOBAL_AGENT mutations alongside global.GLOBAL_AGENT", () => {
    const source = `
      globalThis.GLOBAL_AGENT = {};
      globalThis.GLOBAL_AGENT.NO_PROXY = "localhost";
      globalThis["GLOBAL_AGENT"].HTTP_PROXY = "http://proxy";
      delete globalThis.GLOBAL_AGENT.HTTPS_PROXY;
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([2, 3, 4, 5]);
  });

  it('finds process["env"] mixed access mutations', () => {
    const source = `
      process["env"].HTTP_PROXY = "http://proxy";
      process["env"]["HTTPS_PROXY"] = "http://proxy";
      delete process["env"].NO_PROXY;
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([2, 3, 4]);
  });

  it("does not flag Object.assign on a non-process .env namespace", () => {
    const source = `
      Object.assign(config.env, { NO_PROXY: "localhost" });
      Object.defineProperty(config.env, "HTTP_PROXY", { value: "http://proxy" });
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([]);
  });

  it("ignores reads, unrelated env vars, comments, and strings", () => {
    const source = `
      const current = process.env.HTTP_PROXY;
      process.env.PATH = "/usr/bin";
      const text = "process.env.NO_PROXY = '*'";
      // global.GLOBAL_AGENT.NO_PROXY = '*';
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([]);
  });
});
