import { describe, expect, it } from "vitest";
import {
  createSecretEgressProxyEnvironment,
  omitSecretEgressProxyEnvironment,
} from "./environment.js";

describe("durable environment capture", () => {
  it("removes every recorded injection while preserving operator replacements", () => {
    const injected = createSecretEgressProxyEnvironment(
      "http://proxy.invalid:9000",
      "/arbitrary/ca.pem",
    );
    expect(omitSecretEgressProxyEnvironment(injected)).toEqual({});
    expect(
      omitSecretEgressProxyEnvironment({
        ...injected,
        NODE_EXTRA_CA_CERTS: "/state/secret-egress-proxy/operator-ca.pem",
        HTTPS_PROXY: "http://corporate.invalid:3128",
        CUSTOM_SETTING: "keep",
      }),
    ).toEqual({
      NODE_EXTRA_CA_CERTS: "/state/secret-egress-proxy/operator-ca.pem",
      HTTPS_PROXY: "http://corporate.invalid:3128",
      CUSTOM_SETTING: "keep",
    });
  });

  it("keeps operator trust on later repairs after its receipt is no longer persisted", () => {
    const ca = "/state/secret-egress-proxy/operator-ca.pem";
    const first = omitSecretEgressProxyEnvironment({
      ...createSecretEgressProxyEnvironment("http://proxy.invalid", "/arbitrary/temporary-ca.pem"),
      NODE_EXTRA_CA_CERTS: ca,
    });
    expect(omitSecretEgressProxyEnvironment(first)).toEqual({ NODE_EXTRA_CA_CERTS: ca });
  });

  it("recognizes pre-receipt services without discarding operator trust or proxies", () => {
    const ca = "C:\\state\\secret-egress-proxy\\gateway-old\\trust-bundle.pem";
    expect(
      omitSecretEgressProxyEnvironment(
        {
          node_extra_ca_certs: ca,
          ssl_cert_file: ca,
          requests_ca_bundle: "/opt/corporate.pem",
          https_proxy: "http://openclaw:test-token@127.0.0.1:9000",
          http_proxy: "http://corporate.invalid:3128",
          node_use_env_proxy: "1",
          CUSTOM_SETTING: "keep",
        },
        "win32",
      ),
    ).toEqual({
      requests_ca_bundle: "/opt/corporate.pem",
      http_proxy: "http://corporate.invalid:3128",
      CUSTOM_SETTING: "keep",
    });
  });
});
