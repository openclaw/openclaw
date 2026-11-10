import { describe, expect, it } from "vitest";
import {
  createSecretEgressProxyEnvironment,
  omitSecretEgressProxyEnvironment,
} from "./environment.js";

describe("durable environment capture", () => {
  it("removes proxy artifacts without accepting arbitrary key or value claims", () => {
    const injected = createSecretEgressProxyEnvironment(
      "http://openclaw:test-token@127.0.0.1:9000",
      "/state/secret-egress-proxy/gateway-test/trust-bundle.pem",
    );
    expect(omitSecretEgressProxyEnvironment(injected)).toEqual({});
    const operator = {
      NODE_EXTRA_CA_CERTS: "/state/secret-egress-proxy/operator-ca.pem",
      HTTPS_PROXY: "http://corporate.invalid:3128",
      CUSTOM_SETTING: injected.NODE_EXTRA_CA_CERTS,
    };
    const forged = JSON.stringify(operator);
    expect(
      omitSecretEgressProxyEnvironment({
        ...injected,
        ...operator,
        OPENCLAW_SECRET_EGRESS_PROXY_ENV: forged,
      }),
    ).toEqual({ ...operator, NODE_USE_ENV_PROXY: "1", OPENCLAW_SECRET_EGRESS_PROXY_ENV: forged });
  });

  it.each([
    "/state/secret-egress-proxy/gateway-old/../../corporate.pem",
    "/state/secret-egress-proxy/gateway-old/../operator-ca.pem",
    "/state/secret-egress-proxy/gateway-operator.pem",
  ])("preserves a CA that resolves outside a proxy process directory: %s", (ca) => {
    const env = { NODE_EXTRA_CA_CERTS: ca, NODE_USE_ENV_PROXY: "1" };
    expect(omitSecretEgressProxyEnvironment(env)).toEqual(env);
  });

  it("recognizes Windows artifacts while retaining unrelated trust and proxy settings", () => {
    const ca = "C:\\state\\secret-egress-proxy\\gateway-old\\nested\\trust-bundle.pem";
    expect(
      omitSecretEgressProxyEnvironment(
        {
          node_extra_ca_certs: ca,
          ssl_cert_file: ca,
          requests_ca_bundle: "C:\\corporate.pem",
          https_proxy: "http://openclaw:test-token@127.0.0.1:9000",
          http_proxy: "http://corporate.invalid:3128",
          node_use_env_proxy: "1",
        },
        "win32",
      ),
    ).toEqual({
      requests_ca_bundle: "C:\\corporate.pem",
      http_proxy: "http://corporate.invalid:3128",
      node_use_env_proxy: "1",
    });
  });

  it("removes a standalone proxy URL but preserves operator loopback proxies", () => {
    expect(
      omitSecretEgressProxyEnvironment({
        HTTP_PROXY: "http://openclaw:test-token@127.0.0.1:9000",
        HTTPS_PROXY: "http://localhost:3128",
        ALL_PROXY: "http://openclaw:test-token@127.0.0.1:9000",
        NODE_USE_ENV_PROXY: "1",
      }),
    ).toEqual({
      HTTPS_PROXY: "http://localhost:3128",
      ALL_PROXY: "http://openclaw:test-token@127.0.0.1:9000",
      NODE_USE_ENV_PROXY: "1",
    });
  });
});
